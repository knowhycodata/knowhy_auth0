const { query } = require('../db');
const logger = require('../utils/logger');

async function auditLog(userId, action, resource, details, req, guardrailStatus) {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, resource, details, ip_address, user_agent, guardrail_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        action,
        resource || null,
        details ? JSON.stringify(details) : null,
        req ? (req.ip || req.connection?.remoteAddress) : null,
        req ? req.headers['user-agent'] : null,
        guardrailStatus || null,
      ]
    );
  } catch (error) {
    logger.error('Audit log failed:', { action, error: error.message });
  }
}

module.exports = { auditLog };
