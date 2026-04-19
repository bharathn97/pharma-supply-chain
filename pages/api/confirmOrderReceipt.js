import mysql from 'mysql2/promise';
import dbConfig from '../../middleware/dbConfig';
const { logActivity } = require('../../lib/auditLogger');
const { invalidate, invalidatePattern, publish } = require('../../lib/cache');
const { notifyAllCMOs } = require('../../lib/fcmService');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const { requestId, pharmacyId } = req.body;
  if (!requestId || !pharmacyId) {
    return res.status(400).json({ success: false, message: 'Request ID and Pharmacy ID are required' });
  }

  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    await connection.beginTransaction();

    // The requesting pharmacy confirms receipt after the supplier pharmacy has fulfilled
    // the order (status = 'order_successful'). Match on pharmacy_id (the original requester).
    const [requestCheck] = await connection.execute(`
      SELECT request_id, accepting_pharmacy_id, accepting_warehouse_id FROM pharmacy_emergency_requests
      WHERE request_id = ? AND pharmacy_id = ? AND status = 'order_successful'
    `, [requestId, pharmacyId]);

    if (requestCheck.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Request not found, does not belong to this pharmacy, or is not in order_successful status',
      });
    }

    // Fetch the exact batches that were dispatched for this request
    const [dispatchItems] = await connection.execute(`
      SELECT medicine_id, batch_number, quantity, price_per_unit, expiry_date
      FROM request_dispatch_items
      WHERE request_id = ? AND request_type = 'emergency'
    `, [requestId]);

    // Add each batch to the requesting pharmacy's stock
    // If the same batch_number already exists (e.g. partial transfer earlier), increment quantity
    for (const item of dispatchItems) {
      const [existing] = await connection.execute(`
        SELECT stock_id FROM stock
        WHERE pharmacy_id = ? AND medicine_id = ? AND batch_number = ?
      `, [pharmacyId, item.medicine_id, item.batch_number]);

      if (existing.length > 0) {
        await connection.execute(
          `UPDATE stock SET quantity = quantity + ? WHERE stock_id = ?`,
          [item.quantity, existing[0].stock_id]
        );
      } else {
        await connection.execute(
          `INSERT INTO stock (pharmacy_id, medicine_id, batch_number, quantity, price_per_unit, expiry_date)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [pharmacyId, item.medicine_id, item.batch_number, item.quantity, item.price_per_unit, item.expiry_date]
        );
      }
    }

    await connection.execute(`
      UPDATE pharmacy_emergency_requests SET status = 'order_recieved' WHERE request_id = ?
    `, [requestId]);

    await connection.commit();

    await notifyAllCMOs(
      connection,
      '✅ Emergency Order Received',
      `Pharmacy #${pharmacyId} confirmed receipt of emergency order #${requestId}. Order complete.`,
      { request_id: String(requestId), type: 'emergency_received' }
    ).catch(e => console.error('FCM notify CMO error:', e));

    // Invalidate pharmacy stock (new stock added) and the emergency requests list
    invalidate(`stock:${pharmacyId}`, 'emergency_requests:all');
    invalidatePattern('analytics:cmo:*');
    publish('pharma:events', { type: 'emergency:received', request_id: requestId, pharmacy_id: pharmacyId, accepting_pharmacy_id: requestCheck[0].accepting_pharmacy_id, accepting_warehouse_id: requestCheck[0].accepting_warehouse_id });

    logActivity({
      actor_type: 'pharmacy', actor_id: pharmacyId, actor_name: `Pharmacy #${pharmacyId}`,
      action: 'EMERGENCY_ORDER_RECEIPT_CONFIRMED', entity_type: 'emergency_request', entity_id: requestId,
      description: `Pharmacy #${pharmacyId} confirmed receipt of emergency order #${requestId} — stock updated`,
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Order receipt confirmed successfully',
      data: { requestId, status: 'order_recieved' },
    });

  } catch (error) {
    console.error('Error confirming order receipt:', error);
    try { if (connection) await connection.rollback(); } catch (_) {}
    return res.status(500).json({ success: false, message: 'Internal server error while confirming order receipt' });
  } finally {
    if (connection) await connection.end();
  }
}