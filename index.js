const express = require("express");
const { computeStatus } = require("./availability");

const app = express();
const PORT = process.env.PORT || 3000;

/*
  TEMPORARY MOCK DATA
  This simulates calendar + custom blocks
  Reasons are INTERNAL ONLY
*/
const blocks = [
  {
    start: new Date("2026-01-18T08:30:00"),
    end: new Date("2026-01-18T09:30:00"),
    reason: "Meeting"
  },
  {
    start: new Date("2026-01-18T18:00:00"),
    end: new Date("2026-01-18T19:00:00"),
    reason: "Gym"
  }
];

app.get("/status", (req, res) => {
  const now = new Date();

  const internalResult = computeStatus(now, blocks, {
    preBufferMinutes: 30,
    postBufferMinutes: 30
  });

  /*
    PRIVACY ENFORCEMENT
    Public response never includes reason
  */
  res.json({
    status: internalResult.status,
    nextAvailable: internalResult.nextAvailable
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

