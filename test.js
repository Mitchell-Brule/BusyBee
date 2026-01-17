// test/test.js
const { User, OutlookBusyBlock, CustomBlock } = require('../engine/models')
const { computeStatus } = require('../engine/availability')

const user = new User({ id: 1, name: 'Mitchell', timezone: 'America/Vancouver' })

// Example Outlook busy 8:30-9:30 Monday
user.outlookBlocks.push(new OutlookBusyBlock({ start: '2026-01-19T08:30:00', end: '2026-01-19T09:30:00' }))

// Custom gym block 18:00-19:00 every Mon/Wed/Fri
user.customBlocks.push(new CustomBlock({ type: 'Gym', start: '2026-01-19T18:00:00', end: '2026-01-19T19:00:00', days: ['Mon','Wed','Fri'], recurring: true }))

// Test morning check at 8:15 (buffer should make 8:00 unavailable)
const morning = new Date('2026-01-19T08:15:00')
console.log('Morning status:', computeStatus(user, morning))

// Test evening gym check
const evening = new Date('2026-01-19T18:30:00')
console.log('Evening status:', computeStatus(user, evening))

// Test free time
const freeTime = new Date('2026-01-19T12:00:00')
console.log('Free time status:', computeStatus(user, freeTime))
