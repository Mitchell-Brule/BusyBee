const API_BASE = 'http://localhost:3000';
const ALARM_NAME = 'busybee-reminder-check';

// Clicking the toolbar icon opens the side panel directly, rather than a
// popup that closes the moment you click into the page - the whole point
// of a presence app is that it stays visible while you keep browsing.
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

// Reminders ("tell me when this person is free") need to fire even when
// the side panel isn't open. chrome.alarms wakes this service worker on a
// schedule regardless of whether anything is visually open.
chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) checkReminders();
});

async function checkReminders() {
    const { bb_token } = await chrome.storage.local.get('bb_token');
    if (!bb_token) return;

    let res;
    try {
        res = await fetch(API_BASE + '/api/reminders/check', { headers: { Authorization: `Bearer ${bb_token}` } });
    } catch (err) {
        return; // server not running - try again next tick
    }
    if (!res.ok) return;

    const data = await res.json().catch(() => ({}));
    (data.ready || []).forEach(r => {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: `${r.name} is free`,
            message: `Now showing: ${r.status}`
        });
    });
}
