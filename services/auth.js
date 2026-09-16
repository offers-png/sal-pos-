const crypto = require('crypto');
const { userRepo, getDb } = require('../database');
const { rows } = require('./transactions');
const sessions = new Map(), elevations = new Map(), attempts = new Map();
const expiryTimer = setInterval(() => {
  for (const map of [sessions, elevations]) for (const [key, entry] of map) if (entry.expires < Date.now()) map.delete(key);
  for (const [key, entry] of attempts) if (entry.until < Date.now()) attempts.delete(key);
}, 60000);
expiryTimer.unref();
const managers = user => ['owner', 'manager'].includes(user?.role);
const cookie = req => (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('sal_session='))?.slice(12);
function issue(req, res, user, mustChangePin = false) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.delete(cookie(req));
  sessions.set(token, { userId: user.id, expires: Date.now() + 12 * 60 * 60 * 1000, mustChangePin });
  res.setHeader('Set-Cookie', `sal_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
}
function limit(req, res, next) {
  const id = req.socket.remoteAddress;
  const record = attempts.get(id) || { count: 0, until: Date.now() + 60000 };
  if (record.until < Date.now()) { record.count = 0; record.until = Date.now() + 60000; }
  attempts.set(id, record);
  if (++record.count > 15) return res.status(429).json({ success: false, error: 'Too many PIN attempts; try again in one minute' });
  next();
}
async function authenticate(req, res, next) {
  try {
    const session = sessions.get(cookie(req));
    if (!session || session.expires < Date.now()) return res.status(401).json({ success: false, error: 'Please sign in' });
    const user = await userRepo.getById(session.userId);
    if (!user?.active) return res.status(401).json({ success: false, error: 'Account is inactive' });
    req.user = user; req.session = session; req.sessionToken = cookie(req);
    if (session.mustChangePin && !['/auth/change-pin', '/auth/logout', '/auth/me'].includes(req.path)) return res.status(403).json({ success: false, error: 'Change the default PIN before continuing' });
    next();
  } catch (_) { res.status(401).json({ success: false, error: 'Please sign in again' }); }
}
function manager(req, res, next) {
  const elevation = elevations.get(req.headers['x-manager-token']);
  if (managers(req.user) || (elevation && elevation.session === req.sessionToken && elevation.expires > Date.now())) return next();
  res.status(403).json({ success: false, error: 'Manager authorization required' });
}
function register(app) {
  app.get('/api/auth/setup', async (req, res) => res.json({ setupRequired: !rows(await getDb(), 'SELECT id FROM users LIMIT 1').length }));
  app.post('/api/auth/setup', limit, async (req, res) => {
    try {
      if (rows(await getDb(), 'SELECT id FROM users LIMIT 1').length) return res.status(409).json({ success: false, error: 'Already configured' });
      const { username, pin } = req.body;
      if (!validPin(pin) || typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(username)) throw Error('Use a username and a 6–12 digit PIN other than 1234');
      const id = await userRepo.create({ username, pin, role: 'owner', displayName: username });
      const user = { id, username, role: 'owner', displayName: username };
      issue(req, res, user); res.json({ success: true, user });
    } catch (error) { res.status(400).json({ success: false, error: error.message }); }
  });
  app.get('/api/auth/accounts', async (req, res) => {
    const users = (await userRepo.getAll()).filter(u => u.active).map(({ username, display_name, role }) => ({ username, display_name, role }));
    res.json({ success: true, users });
  });
  app.post('/api/auth/login', limit, async (req, res) => {
    try {
      const { username, pin } = req.body;
      if (typeof username !== 'string' || typeof pin !== 'string') throw Error('Username and PIN required');
      const user = await userRepo.verifyPin(username, pin);
      if (!user) return res.status(401).json({ success: false, error: 'Invalid username or PIN' });
      const mustChangePin = pin === '1234';
      issue(req, res, user, mustChangePin); res.json({ success: true, user, mustChangePin });
    } catch (error) { res.status(400).json({ success: false, error: error.message }); }
  });
  app.use('/api', authenticate);
  app.get('/api/auth/me', (req, res) => res.json({ success: true, user: req.user, mustChangePin: req.session.mustChangePin }));
  app.post('/api/auth/logout', (req, res) => { sessions.delete(req.sessionToken); res.setHeader('Set-Cookie', 'sal_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); res.json({ success: true }); });
  app.post('/api/auth/change-pin', limit, async (req, res) => {
    try {
      if (!validPin(req.body.newPin)) throw Error('PIN must contain 6–12 digits');
      if (!await userRepo.verifyPin(req.user.username, req.body.pin)) throw Error('Current PIN is incorrect');
      await userRepo.updatePin(req.user.id, req.body.newPin);
      for (const [token, session] of sessions) if (session.userId === req.user.id) sessions.delete(token);
      issue(req, res, req.user); res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, error: error.message }); }
  });
  app.post('/api/auth/verify-manager-pin', limit, async (req, res) => {
    if (req.body.pin === '1234') return res.status(403).json({ success: false, error: 'The owner must replace the default PIN first' });
    for (const user of await userRepo.getAll()) {
      if (user.active && managers(user) && typeof req.body.pin === 'string' && await userRepo.verifyPin(user.username, req.body.pin)) {
        const accessToken = crypto.randomBytes(32).toString('hex');
        elevations.set(accessToken, { session: req.sessionToken, expires: Date.now() + 300000 });
        return res.json({ success: true, authorized: true, accessToken, role: user.role });
      }
    }
    res.status(403).json({ success: false, authorized: false });
  });
  app.use('/api', (req, res, next) => {
    if (req.body && typeof req.body === 'object' && !/^\/settings/.test(req.path)) {
      req.body.userId = req.user.id; req.body.user_id = req.user.id;
      req.body.user_name = req.user.display_name || req.user.username;
    }
    const write = req.method !== 'GET';
    const restricted = /^\/(users|backup|backups|migrate|reports|daily-reports|eod-today)/.test(req.path)
      || (write && /^\/(products|settings)/.test(req.path))
      || /\/void$|\/return$/.test(req.path)
      || req.path === '/returns';
    if (restricted) return manager(req, res, next);
    next();
  });
}
function validPin(pin) { return typeof pin === 'string' && /^\d{6,12}$/.test(pin); }
function clearSessions() { sessions.clear(); elevations.clear(); }
module.exports = { register, manager, managers, validPin, clearSessions };
