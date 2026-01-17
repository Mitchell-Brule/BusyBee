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

// Outlook meeting Monday 8:30–9:30
user.outlookBlocks.push(
  new OutlookBusyBlock({
    startISO: '2026-01-19T16:30:00Z',
    endISO: '2026-01-19T17:30:00Z'
  })
)

// Gym M/W/F 18:00–19:30
user.customBlocks.push(
  new CustomBlock({
    type: 'Gym',
    startMinutes: 18 * 60,
    endMinutes: 19 * 60 + 30,
    days: ['Mon','Wed','Fri']
  })
)

// Tests
console.log('08:15 Monday (should be Busy due to buffer):',
  computeStatus(user, new Date('2026-01-19T16:15:00Z'))
)

console.log('12:00 Monday (should be Available):',
  computeStatus(user, new Date('2026-01-19T20:00:00Z'))
)

console.log('18:30 Monday (should be Busy - gym):',
  computeStatus(user, new Date('2026-01-20T02:30:00Z'))
)

