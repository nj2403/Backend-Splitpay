const express = require("express");
const cors = require("cors");

const app = express();

// 🔥 VERY IMPORTANT (fixes your issue)
app.use(cors({
  origin: "*", // you can restrict later
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// In-memory DB (for MVP)
const rooms = {};

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// 🔥 CREATE ROOM API
app.post("/create-room", (req, res) => {
  try {
    console.log("📥 Incoming request:", req.body);

    const { merchantVpa, merchantName, splits } = req.body;

    // Basic validation
    if (!merchantVpa || !splits || splits.length === 0) {
      return res.status(400).json({
        error: "Invalid input"
      });
    }

    // Create room ID
    const roomId = "ROOM_" + Date.now();

    // Save room
    rooms[roomId] = {
      merchantVpa,
      merchantName,
      splits,
      status: "CREATED"
    };

    console.log("✅ Room created:", roomId);

    // 🔥 RESPONSE FORMAT (IMPORTANT FOR FRONTEND)
    return res.json({
      success: true,
      roomId: roomId
    });

  } catch (err) {
    console.error("❌ Error:", err);

    return res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
});

// 🔥 GET ROOM (optional future use)
app.get("/room/:id", (req, res) => {
  const room = rooms[req.params.id];

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json(room);
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
