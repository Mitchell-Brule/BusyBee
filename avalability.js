// engine/availability.js
const { addMinutes, isBefore, isAfter, getDay } = require('date-fns')

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

function isTimeInBlock(time, block, bufferBefore = 0, bufferAfter = 0) {
  const start = addMinutes(block.start, -bufferBefore)
  const end = addMinutes(block.end, bufferAfter)
  return isAfter(time, start) && isBefore(time, end)
}

function isTimeInCustomBlock(time, block, userTimezone, bufferBefore = 0, bufferAfter = 0) {
  const dayName = DAYS[time.getDay()]
  if (block.recurring && !block.days.includes(dayName)) return false
  return isTimeInBlock(time, block, bufferBefore, bufferAfter)
}

// Main function
function computeStatus(user, currentTime = new Date()) {
  const { bufferBefore, bufferAfter, manualOverride, outlookBlocks, customBlocks } = user

  if (manualOverride) return { status: manualOverride, validUntil: null }

  // Check custom blocks first
  for (let block of customBlocks) {
    if (isTimeInCustomBlock(currentTime, block, user.timezone, bufferBefore, bufferAfter)) {
      return { status: 'Busy', validUntil: addMinutes(block.end, bufferAfter) }
    }
  }

  // Then check Outlook blocks
  for (let block of outlookBlocks) {
    if (isTimeInBlock(currentTime, block, bufferBefore, bufferAfter)) {
      return { status: 'Busy', validUntil: addMinutes(block.end, bufferAfter) }
    }
  }

  return { status: 'Available', validUntil: null }
}

module.exports = { computeStatus }
