const { User, OutlookBusyBlock, CustomBlock } = require('./models')
const { computeStatus } = require('./availability')

// Create user
const user = new User({
  id: 1,
  name: 'Mitchell',
  timezone: 'America/Vancouver',
  bufferBefore: 30,
  bufferAfter: 30
})

// Outlook meeting Monday 8:30-9:30
user.outlookBlocks.push(
  new OutlookBusyBlock({
    summary: 'Meeting',
    startISO: '2026-01-19T16:30:00Z',
    endISO: '2026-01-19T17:30:00Z'
  })
)

// Gym M/W/F 18:00-19:30
user.customBlocks.push(
  new CustomBlock({
    type: 'activity',
    label: 'Gym',
    startMinutes: 18 * 60,
    endMinutes: 19 * 60 + 30,
    days: ['Mon', 'Wed', 'Fri']
  })
)

console.log('08:15 Monday (should be Busy due to buffer):',
  computeStatus(user, new Date('2026-01-19T16:15:00Z'))
)

console.log('12:00 Monday (should be Available):',
  computeStatus(user, new Date('2026-01-19T20:00:00Z'))
)

console.log('18:30 Monday (should be Busy - gym):',
  computeStatus(user, new Date('2026-01-20T02:30:00Z'))
)

// --- Grace periods & "Available Soon" -------------------------------
const soonUser = new User({
  id: 2,
  name: 'Soon Tester',
  timezone: 'America/Vancouver',
  bufferBefore: 15,
  bufferAfter: 15
})

// A workout with its own after-buffer override (shower), distinct from
// the user's default 15-minute buffer.
soonUser.customBlocks.push(
  new CustomBlock({
    type: 'activity',
    label: 'Bike ride',
    startMinutes: 17 * 60,
    endMinutes: 18 * 60,
    days: ['Mon'],
    bufferAfterMinutes: 20
  })
)

// Ends at 18:00 + 20min shower grace = 18:20. At 18:10, 10 minutes left.
console.log('18:10 Monday, 10min from free after shower grace (should be Available Soon):',
  computeStatus(soonUser, new Date('2026-01-20T02:10:00Z'))
)

// At 17:30, 50 minutes from free (still mid-ride).
console.log('17:30 Monday, mid-ride (should be Busy):',
  computeStatus(soonUser, new Date('2026-01-20T01:30:00Z'))
)

// --- Midnight-wrapping sleep block + wind-down grace ------------------
const sleepUser = new User({
  id: 3,
  name: 'Sleep Tester',
  timezone: 'America/Vancouver',
  bufferBefore: 15,
  bufferAfter: 15
})

sleepUser.customBlocks.push(
  new CustomBlock({
    type: 'sleep',
    label: 'Sleep',
    startMinutes: 23 * 60,
    endMinutes: 7 * 60,
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    bufferBeforeMinutes: 30, // wind-down before bed
    bufferAfterMinutes: 0
  })
)

// 22:45 Monday Vancouver = winding down before an 23:00 bedtime.
console.log('22:45 Monday, winding down before bed (should be Busy):',
  computeStatus(sleepUser, new Date('2026-01-20T06:45:00Z'))
)

// 03:00 Tuesday Vancouver = still asleep, well past midnight.
console.log('03:00 Tuesday, asleep past midnight (should be Busy):',
  computeStatus(sleepUser, new Date('2026-01-20T11:00:00Z'))
)

// 08:00 Tuesday Vancouver = awake, well clear of the block.
console.log('08:00 Tuesday, awake (should be Available):',
  computeStatus(sleepUser, new Date('2026-01-20T16:00:00Z'))
)

// --- Manual DND override ----------------------------------------------
const dndUser = new User({ id: 4, name: 'DND Tester', timezone: 'America/Vancouver', manualOverride: 'DND' })
console.log('Manual DND override (should be DND regardless of calendar):',
  computeStatus(dndUser, new Date())
)
