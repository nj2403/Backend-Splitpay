const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 4000;

const ALLOWED_ORIGINS = [
  "https://splitpay.fun",
  "https://www.splitpay.fun",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

app.options("*", cors());
app.use(express.json());

const dbPath = path.join(__dirname, "splitpay.db");
const db = new Database(dbPath);

// =========================
// DB SETUP
// =========================
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    merchant_name TEXT,
    merchant_vpa TEXT NOT NULL,
    original_qr_payload TEXT NOT NULL,
    total_amount REAL NOT NULL,
    leader_name TEXT,
    leader_vpa TEXT,
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
    confirmed_at TEXT,
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

// =========================
// HELPERS
// =========================
function generateId(length = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function getRoomWithMembers(roomId) {
  const room = db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(roomId);
  if (!room) return null;

  const members = db.prepare(`SELECT * FROM members WHERE room_id = ? ORDER BY created_at ASC`).all(roomId);

  const totalPaid = members
    .filter((m) => m.status === "paid")
    .reduce((sum, m) => sum + Number(m.paid_amount || m.share_amount || 0), 0);

  let computedStatus = room.status;
  if (totalPaid >= Number(room.total_amount)) {
    computedStatus = "ready_for_leader_payout";
  }

  return {
    ...room,
    status: computedStatus,
    totalPaid,
    remainingAmount: Math.max(Number(room.total_amount) - totalPaid, 0),
    members
  };
}

function validateUpiId(vpa) {
  return typeof vpa === "string" && vpa.includes("@") && vpa.length >= 5;
}

// =========================
// ROUTES
// =========================
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

// Create room
app.post("/rooms", (req, res) => {
  try {
    const {
      merchantName,
      merchantVpa,
      originalQrPayload,
      totalAmount,
      leaderName,
      leaderVpa,
      members
    } = req.body;

    if (!merchantVpa || !validateUpiId(merchantVpa)) {
      return res.status(400).json({ error: "Valid merchant UPI ID is required" });
    }

    if (!originalQrPayload) {
      return res.status(400).json({ error: "Original QR payload is required" });
    }

    if (!totalAmount || Number(totalAmount) <= 0) {
      return res.status(400).json({ error: "Valid total amount is required" });
    }

    if (!leaderName || !String(leaderName).trim()) {
      return res.status(400).json({ error: "Leader name is required" });
    }

    if (!leaderVpa || !validateUpiId(leaderVpa)) {
      return res.status(400).json({ error: "Valid leader UPI ID is required" });
    }

    if (!Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ error: "At least one member is required" });
    }

    const sanitizedMembers = members.map((member) => ({
      name: String(member.name || "Person").trim(),
      phone: member.phone ? String(member.phone).trim() : null,
      shareAmount: Number(member.shareAmount || 0)
    }));

    const invalidMember = sanitizedMembers.find(
      (m) => !m.name || Number.isNaN(m.shareAmount) || m.shareAmount <= 0
    );

    if (invalidMember) {
      return res.status(400).json({ error: "Each member must have a valid name and share amount" });
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
        leader_name,
        leader_vpa,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      roomId,
      merchantName || null,
      merchantVpa,
      originalQrPayload,
      Number(totalAmount),
      String(leaderName).trim(),
      String(leaderVpa).trim(),
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
        paid_amount,
        created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
    `);

    // Add created_at if column missing from old DB
    try {
      db.prepare(`SELECT created_at FROM members LIMIT 1`).get();
    } catch {
      db.exec(`ALTER TABLE members ADD COLUMN created_at TEXT`);
    }

    const transaction = db.transaction((memberList) => {
      memberList.forEach((member) => {
        insertMember.run(
          generateId(12),
          roomId,
          member.name,
          member.phone,
          member.shareAmount,
          now
        );
      });
    });

    transaction(sanitizedMembers);

    return res.status(201).json(getRoomWithMembers(roomId));
  } catch (error) {
    console.error("Create room error:", error);
    return res.status(500).json({ error: "Failed to create room" });
  }
});

// Get room
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

// Create UPI intent for member -> leader collection
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
    const payeeName = encodeURIComponent(room.leader_name || "Leader");
    const payeeVpa = encodeURIComponent(room.leader_vpa);
    const amount = Number(member.share_amount).toFixed(2);

    const intentLink = `upi://pay?pa=${payeeVpa}&pn=${payeeName}&am=${amount}&cu=INR&tn=${note}&tr=${txnRef}`;

    db.prepare(`
      INSERT INTO payment_attempts (
        id,
        room_id,
        member_id,
        amount,
        status,
        intent_link,
        created_at
      ) VALUES (?, ?, ?, ?, 'created', ?, ?)
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
      leaderVpa: room.leader_vpa,
      leaderName: room.leader_name
    });
  } catch (error) {
    console.error("Create intent error:", error);
    return res.status(500).json({ error: "Failed to create payment intent" });
  }
});

// Member says "I have paid"
app.post("/payments/member-confirm", (req, res) => {
  try {
    const { roomId, memberId } = req.body;

    if (!roomId || !memberId) {
      return res.status(400).json({ error: "roomId and memberId are required" });
    }

    const member = db.prepare(`
      SELECT * FROM members
      WHERE id = ? AND room_id = ?
    `).get(memberId, roomId);

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    db.prepare(`
      UPDATE members
      SET status = 'pending_verification',
          confirmed_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), memberId);

    return res.json({
      success: true,
      message: "Marked for leader verification"
    });
  } catch (error) {
    console.error("Member confirm error:", error);
    return res.status(500).json({ error: "Failed to mark payment for verification" });
  }
});

// Leader verifies member collection
app.post("/payments/leader-verify", (req, res) => {
  try {
    const { roomId, memberId, status } = req.body;

    if (!roomId || !memberId || !status) {
      return res.status(400).json({ error: "roomId, memberId and status are required" });
    }

    if (!["paid", "failed"].includes(status)) {
      return res.status(400).json({ error: "Status must be either paid or failed" });
    }

    const member = db.prepare(`
      SELECT * FROM members
      WHERE id = ? AND room_id = ?
    `).get(memberId, roomId);

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (status === "paid") {
      db.prepare(`
        UPDATE members
        SET status = 'paid',
            paid_amount = ?,
            paid_at = ?
        WHERE id = ?
      `).run(
        Number(member.share_amount),
        new Date().toISOString(),
        memberId
      );
    } else {
      db.prepare(`
        UPDATE members
        SET status = 'failed'
        WHERE id = ?
      `).run(memberId);
    }

    return res.json({
      success: true,
      room: getRoomWithMembers(roomId)
    });
  } catch (error) {
    console.error("Leader verify error:", error);
    return res.status(500).json({ error: "Failed to verify member payment" });
  }
});

// Optional manual confirm endpoint if you still want it
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

// Optional fail endpoint
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

// =========================
// ERROR HANDLER
// =========================
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  return res.status(500).json({
    error: err.message || "Internal server error"
  });
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`Split Pay backend running on port ${PORT}`);
});
