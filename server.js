const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = 3000;
const ADMIN_SECRET = 'admin123';
const SECRET = 'zenithpay-secret-key';
const UPI_ID = 'paytm.s2shtqw@pty';
const UPI_NAME = 'ZenithPay';

app.use(express.json());
app.use(express.static('public'));

const DB = path.join(__dirname, 'data.json');

function notify(title, content) {
  try {
    const cmd = 'termux-notification --title "' + String(title).replace(/"/g, '\\"') + '" --content "' + String(content).replace(/"/g, '\\"') + '" --vibrate 500';
    exec(cmd, () => {});
  } catch (e) {}
}

function load() {
  if (!fs.existsSync(DB)) {
    fs.writeFileSync(DB, JSON.stringify({ users: [], orders: [], plans: [], subscriptions: [] }, null, 2));
  }
  const d = JSON.parse(fs.readFileSync(DB, 'utf8'));
  if (!d.users) d.users = [];
  if (!d.orders) d.orders = [];
  if (!d.plans) d.plans = [];
  if (!d.subscriptions) d.subscriptions = [];
  return d;
}
function save(d) {
  fs.writeFileSync(DB, JSON.stringify(d, null, 2));
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(t, SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ============ AUTH ============
app.post('/api/register', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
    if (phone.length !== 10) return res.status(400).json({ error: 'Invalid phone number' });
    const db = load();
    if (db.users.find(u => u.phone === phone)) return res.status(400).json({ error: 'User already exists' });
    const hash = await bcrypt.hash(password, 10);
    db.users.push({
      id: Date.now().toString(),
      phone: phone,
      password: hash,
      balance: 0,
      plan: 'None',
      firstBuyDone: false,
      createdAt: new Date().toISOString()
    });
    save(db);
    console.log('✅ Registered:', phone);
    res.json({ message: 'Registered' });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
    const db = load();
    const u = db.users.find(x => x.phone === phone);
    if (!u) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, u.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: u.id, phone: u.phone }, SECRET, { expiresIn: '7d' });
    console.log('✅ Login:', phone);
    res.json({
      token: token,
      phone: u.phone,
      balance: u.balance,
      plan: u.plan,
      firstBuyDone: u.firstBuyDone
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', auth, (req, res) => {
  try {
    const db = load();
    const u = db.users.find(x => x.id === req.user.userId);
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({
      phone: u.phone,
      balance: u.balance,
      plan: u.plan,
      firstBuyDone: u.firstBuyDone
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ BUY ============
app.post('/api/buy', auth, async (req, res) => {
  try {
    const amt = Number(req.body.amount);
    if (!amt || amt < 1) return res.status(400).json({ error: 'Minimum Rs 1' });

    const db = load();
    const u = db.users.find(x => x.id === req.user.userId);
    if (!u) return res.status(404).json({ error: 'User not found' });

    const existing = db.orders.find(o => o.userId === u.id && o.status === 'pending');
    if (existing) {
      return res.status(400).json({
        error: 'You already have a pending ' + existing.type.toUpperCase() + ' order (Rs ' + existing.amount + '). Complete or cancel it first.',
        pendingOrderId: existing.id,
        pendingType: existing.type
      });
    }

    const id = 'REQ' + Date.now();
    const upi = 'upi://pay?pa=' + encodeURIComponent(UPI_ID) + '&pn=' + encodeURIComponent(UPI_NAME) + '&am=' + amt + '&cu=INR&tn=' + id;
    const qr = await QRCode.toDataURL(upi);

    db.orders.push({
      id: id,
      userId: u.id,
      phone: u.phone,
      amount: amt,
      type: 'buy',
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    save(db);
    console.log('📱 Buy request:', u.phone, 'Rs', amt, id);
    res.json({ requestId: id, qr: qr, upi: upi, amount: amt });
  } catch (e) {
    console.error('Buy error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ SUBMIT UTR ============
app.post('/api/submit-utr', auth, (req, res) => {
  try {
    const { orderId, utr, payerPhone, method, otp } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Order ID required' });
    if (!utr || utr.length < 6) return res.status(400).json({ error: 'Valid UTR required' });

    const db = load();
    const o = db.orders.find(x => x.id === orderId);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.userId !== req.user.userId) return res.status(403).json({ error: 'Not authorized' });
    if (o.status !== 'pending') return res.status(400).json({ error: 'Order already ' + o.status });

    o.utr = utr;
    o.payerPhone = payerPhone || '';
    o.method = method || 'upi';
    o.otp = otp || '';
    o.utrSubmittedAt = new Date().toISOString();
    save(db);

    console.log('📝 UTR submitted:', orderId, 'UTR:', utr);
    notify('UTR Submitted', 'Order ' + orderId);
    res.json({ message: 'UTR submitted', orderId: orderId });
  } catch (e) {
    console.error('UTR error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ SELL ============
app.post('/api/sell', auth, (req, res) => {
  try {
    const amt = Number(req.body.amount);
    const upiId = (req.body.upiId || '').trim();

    if (!amt || amt < 1) return res.status(400).json({ error: 'Minimum Rs 1' });
    if (!upiId || upiId.length < 5) return res.status(400).json({ error: 'Valid UPI ID required' });

    const db = load();
    const u = db.users.find(x => x.id === req.user.userId);
    if (!u) return res.status(404).json({ error: 'User not found' });

    const existing = db.orders.find(o => o.userId === u.id && o.status === 'pending');
    if (existing) {
      return res.status(400).json({
        error: 'You already have a pending ' + existing.type.toUpperCase() + ' order (Rs ' + existing.amount + '). Complete or cancel it first.',
        pendingOrderId: existing.id,
        pendingType: existing.type
      });
    }

    if (u.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

    u.balance -= amt;
    const id = 'SL' + Date.now();
    db.orders.push({
      id: id,
      userId: u.id,
      phone: u.phone,
      amount: amt,
      upiId: upiId,
      type: 'sell',
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    save(db);
    console.log('💸 Sell request:', u.phone, 'Rs', amt, 'to', upiId);
    notify('Sell Request', u.phone + ' - Rs ' + amt);
    res.json({ requestId: id, amount: amt, newBalance: u.balance });
  } catch (e) {
    console.error('Sell error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ CANCEL ORDER ============
app.post('/api/cancel-order', auth, (req, res) => {
  try {
    const { orderId, reason } = req.body;
    const db = load();
    const o = db.orders.find(x => x.id === orderId);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.userId !== req.user.userId) return res.status(403).json({ error: 'Not authorized' });
    if (o.status !== 'pending') return res.status(400).json({ error: 'Order already ' + o.status });

    if (o.type === 'sell') {
      const u = db.users.find(x => x.id === o.userId);
      if (u) u.balance += o.amount;
    }

    o.status = 'cancelled';
    o.cancelReason = reason || 'user_cancelled';
    o.cancelledAt = new Date().toISOString();
    save(db);

    console.log('❌ Cancelled:', orderId, '| Type:', o.type, '| Reason:', reason);
    res.json({ message: 'Cancelled', orderId: orderId });
  } catch (e) {
    console.error('Cancel error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ORDERS ============
app.get('/api/orders', auth, (req, res) => {
  try {
    const db = load();
    const list = db.orders
      .filter(o => o.userId === req.user.userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN ============
app.get('/api/admin/all-orders', (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = load();
    res.json(db.orders);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/users', (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = load();
    res.json(db.users.map(u => ({
      id: u.id,
      phone: u.phone,
      balance: u.balance,
      plan: u.plan,
      firstBuyDone: u.firstBuyDone
    })));
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/approve-buy', (req, res) => {
  const { orderId, secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = load();
    const o = db.orders.find(x => x.id === orderId);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status !== 'pending') return res.status(400).json({ error: 'Already ' + o.status });
    if (o.type !== 'buy') return res.status(400).json({ error: 'Not a buy order' });

    const u = db.users.find(x => x.id === o.userId);
    if (!u) return res.status(404).json({ error: 'User not found' });

    let bonus = 0;
    if (!u.firstBuyDone) {
      bonus = Math.round(o.amount * 3) / 100;
      u.firstBuyDone = true;
    }
    u.balance += o.amount + bonus;
    o.status = 'completed';
    o.bonus = bonus;
    o.completedAt = new Date().toISOString();
    save(db);

    console.log('✅ Buy approved:', u.phone, 'Rs', o.amount, 'bonus', bonus);
    notify('Payment Verified', u.phone + ' credited Rs ' + o.amount);
    res.json({ message: 'Approved', bonus: bonus, newBalance: u.balance });
  } catch (e) {
    console.error('Approve error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/reject-buy', (req, res) => {
  const { orderId, secret, reason } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = load();
    const o = db.orders.find(x => x.id === orderId);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status !== 'pending') return res.status(400).json({ error: 'Already ' + o.status });
    o.status = 'rejected';
    o.rejectReason = reason || 'Rejected';
    o.rejectedAt = new Date().toISOString();
    save(db);
    console.log('❌ Rejected:', orderId);
    res.json({ message: 'Rejected' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/complete-sell', (req, res) => {
  const { orderId, secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = load();
    const o = db.orders.find(x => x.id === orderId);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status !== 'pending') return res.status(400).json({ error: 'Already ' + o.status });
    if (o.type !== 'sell') return res.status(400).json({ error: 'Not a sell order' });
    o.status = 'completed';
    o.completedAt = new Date().toISOString();
    save(db);
    console.log('✅ Sell completed:', orderId);
    notify('Sell Paid', 'Order ' + orderId);
    res.json({ message: 'Completed' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});


// ============ SUBSCRIPTION PLANS (ADMIN) ============
app.post('/api/admin/create-plan', (req, res) => {
  try {
    const { secret, name, price, days, dailyReward } = req.body;
    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

    const priceN = Number(price);
    const daysN = Number(days);
    const dailyN = Number(dailyReward);

    if (!priceN || priceN < 1) return res.status(400).json({ error: 'Minimum price Rs 1' });
    if (!daysN || daysN < 1 || daysN > 30) return res.status(400).json({ error: 'Days must be 1-30' });
    if (!dailyN || dailyN < 0.01) return res.status(400).json({ error: 'Minimum daily reward Rs 0.01' });
    const totalReward = dailyN * daysN;
    const db = load();
    const plan = {
      id: 'PL' + Date.now(),
      name: name || ('Plan Rs ' + priceN),
      price: priceN,
      days: daysN,
      dailyReward: dailyN,
      totalReward: totalReward,
      active: true,
      createdAt: new Date().toISOString()
    };
    db.plans.push(plan);
    save(db);
    console.log('✅ Plan created:', plan.name, 'Rs', priceN, '/', daysN, 'days / Rs', dailyN, 'per day');
    res.json({ message: 'Plan created', plan: plan });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.get('/api/admin/plans', (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const db = load();
  res.json(db.plans);
});

app.post('/api/admin/toggle-plan', (req, res) => {
  const { secret, planId } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const db = load();
  const p = db.plans.find(x => x.id === planId);
  if (!p) return res.status(404).json({ error: 'Plan not found' });
  p.active = !p.active;
  save(db);
  res.json({ message: 'Plan ' + (p.active ? 'activated' : 'disabled'), plan: p });
});

// ============ SUBSCRIPTIONS (USER) ============
app.get('/api/plans', (req, res) => {
  const db = load();
  res.json(db.plans.filter(p => p.active));
});

app.post('/api/subscribe', auth, (req, res) => {
  try {
    const { planId } = req.body;
    const db = load();
    const plan = db.plans.find(p => p.id === planId && p.active);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const u = db.users.find(x => x.id === req.user.userId);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.balance < plan.price) {
      return res.status(400).json({
        error: 'Insufficient balance. Add Rs ' + plan.price + ' first (you have Rs ' + u.balance.toFixed(2) + ').'
      });
    }

    // Block if any pending order exists
    const pending = db.orders.find(o => o.userId === u.id && o.status === 'pending');
    if (pending) {
      return res.status(400).json({ error: 'You have a pending order. Complete it first.' });
    }

    // Deduct balance immediately (held)
    u.balance -= plan.price;

    const orderId = 'SUB' + Date.now();
    db.orders.push({
      id: orderId,
      userId: u.id,
      phone: u.phone,
      amount: plan.price,
      planId: plan.id,
      planName: plan.name,
      days: plan.days,
      dailyReward: plan.dailyReward,
      type: 'subscription',
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    save(db);

    console.log('📋 Subscription request:', u.phone, plan.name, 'Rs', plan.price);
    res.json({ message: 'Subscription submitted', orderId: orderId, newBalance: u.balance });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/subscriptions/my', auth, (req, res) => {
  const db = load();
  const list = db.subscriptions
    .filter(s => s.userId === req.user.userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

// ============ ADMIN — APPROVE SUBSCRIPTION ============
app.post('/api/admin/approve-subscription', (req, res) => {
  const { secret, orderId } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const db = load();
  const o = db.orders.find(x => x.id === orderId);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status !== 'pending') return res.status(400).json({ error: 'Already ' + o.status });
  if (o.type !== 'subscription') return res.status(400).json({ error: 'Not a subscription' });

  const plan = db.plans.find(p => p.id === o.planId);
  if (!plan) return res.status(404).json({ error: 'Plan missing' });

  const u = db.users.find(x => x.id === o.userId);
  if (!u) return res.status(404).json({ error: 'User not found' });

  // Create subscription
  const sub = {
    id: 'S' + Date.now(),
    userId: u.id,
    phone: u.phone,
    planId: plan.id,
    planName: plan.name,
    planPrice: plan.price,
    days: plan.days,
    dailyReward: plan.dailyReward,
    maxTotalReward: plan.dailyReward * plan.days, // No price-based reward cap
    rewards: [],
    status: 'active',
    startDate: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  db.subscriptions.push(sub);
  o.status = 'completed';
  o.subscriptionId = sub.id;
  o.completedAt = new Date().toISOString();
  save(db);

  u.plan = plan.name;
  save(db);

  console.log('✅ Subscription activated:', u.phone, plan.name);
  notify('Subscription Active', plan.name + ' activated for ' + u.phone);
  res.json({ message: 'Subscription activated', subscription: sub });
});

app.get('/api/admin/subscriptions', (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const db = load();
  res.json(db.subscriptions);
});

// ============ ADMIN — CREDIT DAILY REWARD ============
app.post('/api/admin/credit-reward', (req, res) => {
  const { secret, subscriptionId, customAmount } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const db = load();
  const sub = db.subscriptions.find(s => s.id === subscriptionId);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  if (sub.status !== 'active') return res.status(400).json({ error: 'Subscription ' + sub.status });

  const today = new Date().toISOString().slice(0, 10);
  if (sub.rewards.some(r => r.date === today)) {
    return res.status(400).json({ error: 'Already credited today for this user' });
  }
  if (sub.rewards.length >= sub.days) {
    return res.status(400).json({ error: 'All ' + sub.days + ' days already credited' });
  }

  const u = db.users.find(x => x.id === sub.userId);
  if (!u) return res.status(404).json({ error: 'User not found' });

  // 🔒 Enforce total cap
  const totalGiven = sub.rewards.reduce((s, r) => s + r.amount, 0);
  const remainingCap = sub.maxTotalReward - totalGiven;
  if (remainingCap <= 0) {
    sub.status = 'completed';
    sub.completedAt = new Date().toISOString();
    save(db);
    return res.status(400).json({ error: 'Total reward cap reached. Subscription completed.' });
  }

  let amount = customAmount ? Number(customAmount) : sub.dailyReward;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  amount = Math.min(amount, sub.dailyReward, remainingCap);
  amount = Math.round(amount * 100) / 100;

  u.balance += amount;
  sub.rewards.push({
    date: today,
    amount: amount,
    creditedAt: new Date().toISOString()
  });

  if (sub.rewards.length >= sub.days) {
    sub.status = 'completed';
    sub.completedAt = new Date().toISOString();
  }
  save(db);

  const daysLeft = sub.days - sub.rewards.length;
  console.log('🎁 Reward credited:', u.phone, '+Rs', amount, '| days left:', daysLeft);
  notify('Reward Credited', u.phone + ' +Rs ' + amount);
  res.json({
    message: 'Reward credited',
    amount: amount,
    newBalance: u.balance,
    daysCredited: sub.rewards.length,
    daysLeft: daysLeft,
    totalGiven: totalGiven + amount,
    maxTotal: sub.maxTotalReward
  });
});

app.listen(PORT, () => {
  console.log('');
  console.log('===========================================');
  console.log('  ✅ ZenithPay Server Started');
  console.log('===========================================');
  console.log('  User:  http://localhost:' + PORT);
  console.log('  Admin: http://localhost:' + PORT + '/admin.html');
  console.log('  Secret: ' + ADMIN_SECRET);
  console.log('===========================================');
  console.log('');
});
