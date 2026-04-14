const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 4000;

// Replace with your real frontend domains
const ALLOWED_ORIGINS = [
  "https://splitpay.fun/",
  "https://www.yourdomain.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("CORS not allowed for this origin"));
    }
  })
);

app.use(express.json());

const dbPath = path.join(__dirname, "splitpay.db");
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    merchant_name TEXT,
    merchant_vpa TEXT NOT NULL,
    original_qr_payload TEXT NOT NULL,
    total_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    share_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    paid_amount REAL DEFAULT 0,
    transaction_ref TEXT,
    paid_at TEXT,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
  );

  CREATE TABLE IF NOT EXISTS payment_attempts (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    intent_link TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id),
    FOREIGN KEY (member_id) REFERENCES members(id)
  );
`);

function generateId(length = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function getRoomWithMembers(roomId) {
  const room = db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(roomId);
  if (!room) return null;

  const members = db.prepare(`SELECT * FROM members WHERE room_id = ?`).all(roomId);

  const totalPaid = members
    .filter((m) => m.status === "paid")
    .reduce((sum, m) => sum + Number(m.paid_amount || 0), 0);

  let computedStatus = room.status;
  if (totalPaid >= Number(room.total_amount)) {
    computedStatus = "completed";
    db.prepare(`UPDATE rooms SET status = 'completed' WHERE id = ?`).run(roomId);
  }

  return {
    ...room,
    status: computedStatus,
    totalPaid,
    remainingAmount: Math.max(Number(room.total_amount) - totalPaid, 0),
    members
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Split Pay backend root is working"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Split Pay backend is running"
  });
});

app.post("/rooms", (req, res) => {
  try {
    const { merchantName, merchantVpa, originalQrPayload, totalAmount, members } = req.body;

    if (
      !merchantVpa ||
      !originalQrPayload ||
      !totalAmount ||
      !Array.isArray(members) ||
      members.length === 0
    ) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const roomId = generateId(10);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO rooms (
        id,
        merchant_name,
        merchant_vpa,
        original_qr_payload,
        total_amount,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `).run(
      roomId,
      merchantName || null,
      merchantVpa,
      originalQrPayload,
      Number(totalAmount),
      now
    );

    const insertMember = db.prepare(`
      INSERT INTO members (
        id,
        room_id,
        name,
        phone,
        share_amount,
        status,
        paid_amount
      )
      VALUES (?, ?, ?, ?, ?, 'pending', 0)
    `);

    const transaction = db.transaction((memberList) => {
      memberList.forEach((member) => {
        insertMember.run(
          generateId(12),
          roomId,
          member.name || "Person",
          member.phone || null,
          Number(member.shareAmount || 0)
        );
      });
    });

    transaction(members);

    return res.status(201).json(getRoomWithMembers(roomId));
  } catch (error) {
    console.error("Create room error:", error);
    return res.status(500).json({ error: "Failed to create room" });
  }
});

app.get("/rooms/:roomId", (req, res) => {
  try {
    const room = getRoomWithMembers(req.params.roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    return res.json(room);
  } catch (error) {
    console.error("Get room error:", error);
    return res.status(500).json({ error: "Failed to fetch room" });
  }
});

app.post("/payments/create-intent", (req, res) => {
  try {
    const { roomId, memberId } = req.body;

    const room = db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(roomId);
    const member = db.prepare(`SELECT * FROM members WHERE id = ? AND room_id = ?`).get(memberId, roomId);

    if (!room || !member) {
      return res.status(404).json({ error: "Room or member not found" });
    }

    const attemptId = generateId(12);
    const txnRef = `SP${Date.now()}${Math.floor(Math.random() * 1000)}`;

    const note = encodeURIComponent(`SplitPay ${roomId} ${member.name}`);
    const merchantName = encodeURIComponent(room.merchant_name || "Merchant");
    const payeeVpa = encodeURIComponent(room.merchant_vpa);
    const amount = Number(member.share_amount).toFixed(2);

    const intentLink = `upi://pay?pa=${payeeVpa}&pn=${merchantName}&am=${amount}&cu=INR&tn=${note}&tr=${txnRef}`;

    db.prepare(`
      INSERT INTO payment_attempts (
        id,
        room_id,
        member_id,
        amount,
        status,
        intent_link,
        created_at
      )
      VALUES (?, ?, ?, ?, 'created', ?, ?)
    `).run(
      attemptId,
      roomId,
      memberId,
      Number(member.share_amount),
      intentLink,
      new Date().toISOString()
    );

    db.prepare(`
      UPDATE members
      SET transaction_ref = ?
      WHERE id = ?
    `).run(txnRef, memberId);

    return res.json({
      attemptId,
      transactionRef: txnRef,
      intentLink,
      amount: Number(member.share_amount),
      merchantVpa: room.merchant_vpa
    });
  } catch (error) {
    console.error("Create intent error:", error);
    return res.status(500).json({ error: "Failed to create payment intent" });
  }
});

app.post("/payments/confirm", (req, res) => {
  try {
    const { roomId, memberId, paidAmount, transactionRef } = req.body;

    const member = db.prepare(`
      SELECT * FROM members
      WHERE id = ? AND room_id = ?
    `).get(memberId, roomId);

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    db.prepare(`
      UPDATE members
      SET status = 'paid',
          paid_amount = ?,
          paid_at = ?,
          transaction_ref = COALESCE(?, transaction_ref)
      WHERE id = ?
    `).run(
      Number(paidAmount || member.share_amount),
      new Date().toISOString(),
      transactionRef || null,
      memberId
    );

    db.prepare(`
      UPDATE payment_attempts
      SET status = 'paid'
      WHERE member_id = ? AND room_id = ?
    `).run(memberId, roomId);

    return res.json(getRoomWithMembers(roomId));
  } catch (error) {
    console.error("Confirm payment error:", error);
    return res.status(500).json({ error: "Failed to confirm payment" });
  }
});

app.post("/payments/fail", (req, res) => {
  try {
    const { roomId, memberId } = req.body;

    const member = db.prepare(`
      SELECT * FROM members
      WHERE id = ? AND room_id = ?
    `).get(memberId, roomId);

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    db.prepare(`
      UPDATE members
      SET status = 'failed'
      WHERE id = ?
    `).run(memberId);

    db.prepare(`
      UPDATE payment_attempts
      SET status = 'failed'
      WHERE member_id = ? AND room_id = ?
    `).run(memberId, roomId);

    return res.json(getRoomWithMembers(roomId));
  } catch (error) {
    console.error("Fail payment error:", error);
    return res.status(500).json({ error: "Failed to mark payment failed" });
  }
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  return res.status(500).json({
    error: err.message || "Internal server error"
  });
});

app.listen(PORT, () => {
  console.log(`Split Pay backend running on port ${PORT}`);
});
