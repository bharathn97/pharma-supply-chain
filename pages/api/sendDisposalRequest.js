import mysql from 'mysql2/promise';
import dbConfig from '../../middleware/dbConfig';
const { logActivity } = require('../../lib/auditLogger');
const { notifyUsers } = require('../../lib/fcmService');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  let connection;
  try {
    const { request_id } = req.body;

    if (!request_id) {
      return res.status(400).json({
        success: false,
        message: 'request_id is required'
      });
    }

    connection = await mysql.createConnection(dbConfig);

    // Update disposal request status to 'request_sent'
    await connection.execute(
      `UPDATE pharmacy_disposal_request
       SET status = 'request_sent'
       WHERE request_id = ?`,
      [request_id]
    );

    // Fetch pharmacy name for notification
    const [[disposalReq]] = await connection.execute(
      `SELECT pharmacy_id FROM pharmacy_disposal_request WHERE request_id = ?`,
      [request_id]
    );
    const pharmacyId = disposalReq?.pharmacy_id;

    // Notify all warehouses registered in push_tokens
    const [warehouseRows] = await connection.execute(
      `SELECT DISTINCT user_id FROM push_tokens WHERE user_type = 'warehouse'`
    );
    const warehouseIds = warehouseRows.map(r => r.user_id);
    if (warehouseIds.length > 0) {
      await notifyUsers(
        connection, 'warehouse', warehouseIds,
        '🗑️ New Disposal Request',
        `A new disposal request #${request_id} has been sent by Pharmacy #${pharmacyId || request_id}. Please collect.`,
        { request_id: String(request_id), type: 'disposal_request' }
      ).catch(e => console.error('FCM notify warehouse error:', e));
    }

    await connection.end();

    logActivity({
      actor_type: 'pharmacy', actor_id: request_id, actor_name: 'Pharmacy',
      action: 'DISPOSAL_REQUEST_SENT', entity_type: 'disposal_request', entity_id: request_id,
      description: `Disposal request #${request_id} sent to warehouse for collection`,
      metadata: { request_id }
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Disposal request sent to warehouse',
      status: 'request_sent'
    });

  } catch (error) {
    console.error('Error sending disposal request:', error);
    if (connection) await connection.end();
    res.status(500).json({
      success: false,
      message: 'Error sending disposal request',
      error: error.message
    });
  }
}
