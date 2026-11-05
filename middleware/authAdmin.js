'use strict';
const jwt = require('jsonwebtoken');
const COOKIE = 'zeta_admin';
function authAdmin(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (p.role !== 'admin') throw new Error('bad role');
    req.admin = p; next();
  } catch { res.clearCookie(COOKIE, { path: '/' }); return res.status(401).json({ error: 'Unauthorized' }); }
}
module.exports = { authAdmin, COOKIE };
