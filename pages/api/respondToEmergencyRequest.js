import mysql from 'mysql2/promise';
import dbConfig from '../../middleware/dbConfig';
const { notifyUsers } = require('../../lib/fcmService');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { request_id, responding_pharmacy_id, action, remarks } = req.body;

    if (!request_id || !responding_pharmacy_id || !action) {
      return res.status(400).json({ 
        success: false, 
        message: 'Request ID, responding pharmacy ID, and action are required' 
      });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Action must be either "approve" or "reject"' 
      });
    }

    const connection = await mysql.createConnection(dbConfig);

    // Start transaction
    await connection.beginTransaction();

    try {
      // First, verify that this pharmacy is the target of the request
      const verifyQuery = `
        SELECT pharmacy_id, target_pharmacy_id, status 
        FROM pharmacy_emergency_requests 
        WHERE request_id = ? AND target_pharmacy_id = ?
      `;
      
      const [verifyResult] = await connection.execute(verifyQuery, [request_id, responding_pharmacy_id]);

      if (verifyResult.length === 0) {
        await connection.rollback();
        await connection.end();
        return res.status(403).json({ 
          success: false, 
          message: 'You are not authorized to respond to this request' 
        });
      }

      if (verifyResult[0].status !== 'pending_approval_from_target_pharmacy') {
        await connection.rollback();
        await connection.end();
        return res.status(400).json({ 
          success: false, 
          message: 'This request has already been responded to' 
        });
      }

      // Update the emergency request with the response
      const updateQuery = `
        UPDATE pharmacy_emergency_requests 
        SET status = ?, response_remarks = ?, response_date = NOW()
        WHERE request_id = ?
      `;

      await connection.execute(updateQuery, [action === 'approve' ? 'approved' : 'rejected', remarks || '', request_id]);

      // Commit transaction
      await connection.commit();

      const requestingPharmacyId = verifyResult[0].pharmacy_id;
      await notifyUsers(
        connection, 'pharmacy', [requestingPharmacyId],
        action === 'approve' ? '✅ Emergency Order Accepted' : '❌ Emergency Order Declined',
        action === 'approve'
          ? `The assigned pharmacy has accepted emergency request #${request_id} and will prepare the stock.`
          : `The assigned pharmacy has declined emergency request #${request_id}.${remarks ? ' Reason: ' + remarks : ''}`,
        { request_id: String(request_id), type: 'emergency_response' }
      ).catch(e => console.error('FCM notify pharmacy error:', e));

      await connection.end();

      res.status(200).json({
        success: true,
        message: `Request ${action}d successfully`
      });

    } catch (transactionError) {
      await connection.rollback();
      await connection.end();
      throw transactionError;
    }

  } catch (error) {
    console.error('Error responding to emergency request:', error);
    
    // If the error is about missing column, provide helpful message
    if (error.message.includes("target_pharmacy_id")) {
      res.status(500).json({
        success: false,
        message: 'Database schema needs to be updated. Please add target_pharmacy_id and response_date columns to pharmacy_emergency_requests table.'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
}