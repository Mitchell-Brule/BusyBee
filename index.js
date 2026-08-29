const express = require("express");
const session = require("express-session");
const { computeStatus } = require("./availability");
const { toZonedTime, addMinutes } = require("date-fns-tz");
const { getAuthUrl, getTokens, getBusyBlocks, oAuth2Client } = require("./googleAuth");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(session({ secret: "busybee-secret", resave: false, saveUninitialized: true }));

// Mock data: replace later with calendar imports
const blocks = [
  { start: "08:30", end: "09:30", reason: "Meeting" },
  { start: "18:00", end: "19:00", reason: "Gym" }
];

// Homepage route
app.get("/", (req, res) => {
  res.send("BusyBee API running. Go to /status");
});

// Google login route
app.get("/auth/google", (req, res) => {
  const url = getAuthUrl();
  res.redirect(url);
});

// OAuth callback route
app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const tokens = await getTokens(code);
    req.session.tokens = tokens;
    res.send("Google Calendar connected! Now check /status for live availability.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error connecting Google Calendar.");
  }
});

// Status route
app.get("/status", async (req, res) => {
  let googleBusy = [];
  if (req.session.tokens) {
    oAuth2Client.setCredentials(req.session.tokens);
    const now = new Date();
    const end = new Date(now.getTime() + 24 * 60 * 60 * 1000); // next 24 hours
    googleBusy = await getBusyBlocks(oAuth2Client, now, end);
  }

  const user = {
    timezone: "America/Vancouver",
    customBlocks: blocks.map(b => {
      const [startH, startM] = b.start.split(":").map(Number);
      const [endH, endM] = b.end.split(":").map(Number);
      return {
        startMinutes: startH * 60 + startM,
        endMinutes: endH * 60 + endM,
        days: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],
        enabled: true
      };
    }),
    outlookBlocks: googleBusy.map(b => ({
      startISO: b.start.toISOString(),
      endISO: b.end.toISOString()
    })),
    bufferBefore: 30,
    bufferAfter: 30
  };

  const nowUTC = new Date();
  const now = toZonedTime(nowUTC, user.timezone);
  const internalResult = computeStatus(user, nowUTC);

  let nextAvailable = internalResult.validUntil;

  if (internalResult.status === "Busy") {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const today = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getDay()];

    for (const block of user.customBlocks) {
      if (!block.enabled || !block.days.includes(today)) continue;
      if (nowMinutes >= block.startMinutes - user.bufferBefore && nowMinutes <= block.endMinutes + user.bufferAfter) {
        const endHour = Math.floor(block.endMinutes / 60);
        const endMin = block.endMinutes % 60;
        const endDate = new Date(now);
        endDate.setHours(endHour);
        endDate.setMinutes(endMin);
        endDate.setSeconds(0);
        nextAvailable = addMinutes(endDate, user.bufferAfter);
        break;
      }
    }
  }

  res.json({ status: internalResult.status, nextAvailable });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});