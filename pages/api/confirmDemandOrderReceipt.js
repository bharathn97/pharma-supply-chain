import mysql from 'mysql2/promise';
import dbConfig from '../../middleware/dbConfig';
const { logActivity } = require('../../lib/auditLogger');
const { invalidate, invalidatePattern, publish } = require('../../lib/cache');
const { notifyAllCMOs } = require('../../lib/fcmService');

// POST /api/confirmDemandOrderReceipt
// Body: { request_id, pharmacy_id }
// When pharmacy confirms receipt of a dispatched demand order:
//   1. Inserts stock records for each requested medicine into the pharmacy's stock
//   2. Updates demand request status from 'order_successful' → 'order_recieved'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const { request_id, pharmacy_id } = req.body;
  if (!request_id || !pharmacy_id) {
    return res.status(400).json({ success: false, message: 'request_id and pharmacy_id are required' });
  }

  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    await connection.beginTransaction();

    // Verify this demand request belongs to this pharmacy and is in order_successful status
    const [requestCheck] = await connection.execute(`
      SELECT request_id, pharmacy_id, accepting_warehouse_id, status
      FROM pharmacy_demand_request
      WHERE request_id = ? AND pharmacy_id = ? AND status = 'order_successful'
    `, [request_id, pharmacy_id]);

    if (requestCheck.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Demand request not found, does not belong to this pharmacy, or is not in order_successful status',
      });
    }

    // Fetch the exact batches that the warehouse dispatched for this request
    const [dispatchItems] = await connection.execute(`
      SELECT medicine_id, batch_number, quantity, price_per_unit, expiry_date
      FROM request_dispatch_items
      WHERE request_id = ? AND request_type = 'demand'
    `, [request_id]);

    if (dispatchItems.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No dispatch records found for this demand request. The warehouse may not have recorded allocations.' });
    }

    // Add each exact batch to the requesting pharmacy's stock
    // If the same batch_number already exists, increment quantity
    const insertedItems = [];
    for (const item of dispatchItems) {
      const [existing] = await connection.execute(`
        SELECT stock_id FROM stock
        WHERE pharmacy_id = ? AND medicine_id = ? AND batch_number = ?
      `, [pharmacy_id, item.medicine_id, item.batch_number]);

      if (existing.length > 0) {
        await connection.execute(
          `UPDATE stock SET quantity = quantity + ? WHERE stock_id = ?`,
          [item.quantity, existing[0].stock_id]
        );
      } else {
        await connection.execute(
          `INSERT INTO stock (pharmacy_id, medicine_id, batch_number, quantity, price_per_unit, expiry_date)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [pharmacy_id, item.medicine_id, item.batch_number, item.quantity, item.price_per_unit, item.expiry_date]
        );
      }

      insertedItems.push({ medicine_id: item.medicine_id, batch_number: item.batch_number, quantity: item.quantity });
    }

    // Update status to order_recieved (matching the enum typo in DB)
    await connection.execute(`
      UPDATE pharmacy_demand_request
      SET status = 'order_recieved'
      WHERE request_id = ?
    `, [request_id]);

    await connection.commit();

    await notifyAllCMOs(
      connection,
      '✅ Demand Order Received',
      `Pharmacy #${pharmacy_id} confirmed receipt of demand order #${request_id}. Order complete.`,
      { request_id: String(request_id), type: 'demand_received' }
    ).catch(e => console.error('FCM notify CMO error:', e));

    // Invalidate pharmacy stock (new stock added) and the demand requests list
    invalidate(`stock:${pharmacy_id}`, 'demand_requests:all');
    invalidatePattern('analytics:cmo:*');
    publish('pharma:events', { type: 'demand:received', request_id, pharmacy_id, accepting_warehouse_id: requestCheck[0].accepting_warehouse_id });

    logActivity({
      actor_type: 'pharmacy', actor_id: pharmacy_id, actor_name: `Pharmacy #${pharmacy_id}`,
      action: 'DEMAND_ORDER_RECEIPT_CONFIRMED', entity_type: 'demand_request', entity_id: request_id,
      description: `Pharmacy #${pharmacy_id} confirmed receipt of demand order #${request_id} — ${insertedItems} batch(es) added to stock`,
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Order receipt confirmed. Stock has been added to your inventory.',
      inserted_items: insertedItems,
    });

  } catch (error) {
    console.error('Error confirming demand order receipt:', error);
    try { if (connection) await connection.rollback(); } catch (_) {}
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  } finally {
    if (connection) await connection.end();
  }
}
