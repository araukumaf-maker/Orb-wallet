const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, 'data.json');
const CHECK = 2000;
let seen = new Set();

function load() {
  if (!fs.existsSync(DB)) return { users: [], orders: [] };
  return JSON.parse(fs.readFileSync(DB, 'utf8'));
}
function save(d) { fs.writeFileSync(DB, JSON.stringify(d, null, 2)); }

function notify(title, content) {
  const cmd = 'termux-notification --title "' + title.replace(/"/g, '\\"') + '" --content "' + content.replace(/"/g, '\\"') + '" --vibrate 500';
  exec(cmd, (err) => { if (err) console.error(err.message); });
}

function extractAmount(text) {
  const m = text.match(/(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}
function extractReqId(text) {
  const m = text.match(/(REQ\d+)/i);
  return m ? m[1] : null;
}

function process(text) {
  const db = load();
  const amt = extractAmount(text);
  const reqId = extractReqId(text);
  console.log('Notification: Rs ' + amt + ' | ReqID: ' + (reqId || 'N/A'));

  // 1. Direct Request ID match
  if (reqId) {
    const o = db.orders.find(x => x.id === reqId && x.status === 'pending' && x.type === 'buy');
    if (o) {
      const u = db.users.find(x => x.id === o.userId);
      if (u) {
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
        console.log('✅ Credited Rs ' + o.amount + ' + bonus ' + bonus + ' to ' + u.phone);
        notify('Payment Verified', u.phone + ' credited Rs ' + o.amount);
        return;
      }
    }
  }

  // 2. Amount match
  if (amt) {
    const pending = db.orders.filter(x => x.status === 'pending' && x.type === 'buy' && Math.abs(x.amount - amt) < 0.01);
    if (pending.length === 1) {
      const o = pending[0];
      const u = db.users.find(x => x.id === o.userId);
      if (u) {
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
        console.log('✅ Credited Rs ' + o.amount + ' to ' + u.phone);
        notify('Payment Verified', u.phone + ' credited Rs ' + o.amount);
      }
    } else if (pending.length > 1) {
      notify('Multiple Matches', 'Rs ' + amt + ' ke ' + pending.length + ' orders. Manual approve.');
    } else {
      notify('No Request', 'Rs ' + amt + ' aaya, koi pending order nahi.');
    }
  }
}

function check() {
  exec('termux-notification-list', (err, stdout) => {
    if (err) return;
    let notifs;
    try { notifs = JSON.parse(stdout); } catch (e) { return; }
    for (const n of notifs) {
      if (n.packageName !== 'com.paytm.business') continue;
      const text = (n.title || '') + ' ' + (n.content || '');
      const key = (n.id || '') + '|' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      process(text);
    }
  });
}

console.log('========================================');
console.log('  Paytm Business Watcher');
console.log('========================================');
console.log('Listening for com.paytm.business...');

// Skip existing on start
exec('termux-notification-list', (err, stdout) => {
  if (err) return;
  try {
    const notifs = JSON.parse(stdout);
    let c = 0;
    for (const n of notifs) {
      if (n.packageName === 'com.paytm.business') {
        const key = (n.id || '') + '|' + ((n.title || '') + ' ' + (n.content || ''));
        seen.add(key);
        c++;
      }
    }
    console.log('Marked ' + c + ' existing notifications as seen.');
  } catch (e) {}
});

setInterval(check, CHECK);
