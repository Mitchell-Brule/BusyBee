require("dotenv").config();
console.log("CLIENT ID:", process.env.GOOGLE_CLIENT_ID);

const { google } = require("googleapis");

// OAuth2 client setup
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Define the scopes we need
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly" // read-only access to user's calendar
];

// Generate URL for login
function getAuthUrl() {
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
}

// Exchange code for tokens
async function getTokens(code) {
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  return tokens;
}

// Fetch busy times from Google Calendar
async function getBusyBlocks(oAuthClient, start, end) {
  const calendar = google.calendar({ version: "v3", auth: oAuthClient });
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: "primary" }],
    },
  });

  const busy = res.data.calendars.primary.busy || [];
  return busy.map(b => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
}

module.exports = { getAuthUrl, getTokens, getBusyBlocks, oAuth2Client };