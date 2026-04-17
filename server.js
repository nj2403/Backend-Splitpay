const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your site + Android WebView + local testing
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// In-memory MVP storage
const rooms = {};

function generateId(prefix = "room") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function validateUpiId(vpa) {
  return typeof vpa === "string" && vpa.includes("@") && vpa.trim().length >= 5;
}

function normalizeRoom(room) {
  const totalPaid = room.members
    .filter((m) => m.status === "paid")
    .reduce((sum, m) => sum + Number(m.paid_amount || m.share_amount || 0), 0);

  return {
    ...room,
    totalPaid,
    remainingAmount: Math.max(Number(room.total_amount || 0) - totalPaid, 0)
  };
}

// Health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Split Pay backend is running"
  });
});

// Create room
app.post("/rooms", (req, res) => {
  try {
    console.log("POST /rooms body:", req.body);

    const {
      merchantName,
      merchantVpa,
      originalQrPayload,
      totalAmount,
      leaderName,
      leaderVpa,
      members
    } = req.body || {};

    if (!merchantVpa || !validateUpiId(merchantVpa)) {
      return res.status(400).json({ error: "Valid merchant UPI ID is required" });
    }

    if (!leaderVpa || !validateUpiId(leaderVpa)) {
      return res.status(400).json({ error: "Valid leader UPI ID is required" });
    }

    if (!leaderName || !String(leaderName).trim()) {
      return res.status(400).json({ error: "Leader name is required" });
    }

    if (!totalAmount || Number(totalAmount) <= 0) {
      return res.status(400).json({ error: "Valid total amount is required" });
    }

    if (!Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ error: "At least one member is required" });
    }

    const cleanMembers = members.map((m) => ({
      id: generateId("member"),
      name: String(m.name || "Person").trim(),
      phone: m.phone ? String(m.phone).trim() : "",
      share_amount: Number(m.shareAmount || 0),
      paid_amount: 0,
      status: "pending",
      transaction_ref: null,
      paid_at: null,
      confirmed_at: null
    }));

    const invalid = cleanMembers.find(
      (m) => !m.name || Number.isNaN(m.share_amount) || m.share_amount <= 0
    );

    if (invalid) {
      return res.status(400).json({ error: "Each member must have valid name and share amount" });
    }

    const roomId = generateId("room");
    const now = new Date().toISOString();

    const room = {
      id: roomId,
      merchant_name: merchantName || "Merchant",
      merchant_vpa: merchantVpa.trim(),
      original_qr_payload: originalQrPayload || "",
      total_amount: Number(totalAmount),
      leader_name: String(leaderName).trim(),
      leader_vpa: String(leaderVpa).trim(),
      status: "active",
      created_at: now,
      members: cleanMembers
    };

    rooms[roomId] = room;

    return res.status(201).json(normalizeRoom(room));
  } catch (error) {
    console.error("CREATE ROOM ERROR:", error);
    return res.status(500).json({ error: error.message || "Failed to create room" });
  }
});

// Get room
app.get("/rooms/:roomId", (req, res) => {
  try {
    const room = rooms[req.params.roomId];
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    return res.json(normalizeRoom(room));
  } catch (error) {
    console.error("GET ROOM ERROR:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch room" });
  }
});

// Member marks "I have paid"
app.post("/payments/member-confirm", (req, res) => {
  try {
    const { roomId, memberId } = req.body || {};

    if (!roomId || !memberId) {
      return res.status(400).json({ error: "roomId and memberId are required" });
    }

    const room = rooms[roomId];
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    const member = room.members.find((m) => m.id === memberId);
    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    member.status = "pending_verification";
    member.confirmed_at = new Date().toISOString();

    return res.json({
      success: true,
      message: "Marked for leader verification",
      room: normalizeRoom(room)
    });
  } catch (error) {
    console.error("MEMBER CONFIRM ERROR:", error);
    return res.status(500).json({ error: error.message || "Failed to mark payment" });
  }
});

// Leader verifies member payment
app.post("/payments/leader-verify", (req, res) => {
  try {
    const { roomId, memberId, status } = req.body || {};

    if (!roomId || !memberId || !status) {
      return res.status(400).json({ error: "roomId, memberId and status are required" });
    }

    if (!["paid", "failed"].includes(status)) {
      return res.status(400).json({ error: "Status must be paid or failed" });
    }

    const room = rooms[roomId];
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    const member = room.members.find((m) => m.id === memberId);
    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (status === "paid") {
      member.status = "paid";
      member.paid_amount = Number(member.share_amount);
      member.paid_at = new Date().toISOString();
    } else {
      member.status = "failed";
    }

    return res.json({
      success: true,
      room: normalizeRoom(room)
    });
  } catch (error) {
    console.error("LEADER VERIFY ERROR:", error);
    return res.status(500).json({ error: error.message || "Failed to verify payment" });
  }
});

// Optional root route
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Split Pay backend root is working"
  });
});

app.listen(PORT, () => {
  console.log(`Split Pay backend running on port ${PORT}`);
});
