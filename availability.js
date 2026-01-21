// availability.js
const { addMinutes, isBefore, isAfter } = require('date-fns')
const { utcToZonedTime } = require('date-fns-tz')

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

function isNowInBufferedRange(now, start, end, bufferBefore, bufferAfter) {
  const bufferedStart = addMinutes(start, -bufferBefore)
  const bufferedEnd = addMinutes(end, bufferAfter)
  return isAfter(now, bufferedStart) && isBefore(now, bufferedEnd)
}

function getTodayMinutes(zonedDate) {
  return zonedDate.getHours() * 60 + zonedDate.getMinutes()
}

function computeStatus(user, nowUTC = new Date()) {
  const {
    timezone,
    bufferBefore,
    bufferAfter,
    outlookBlocks,
    customBlocks,
    manualOverride
  } = user

  if (manualOverride) {
    return { status: manualOverride, validUntil: null }
  }

  const nowZoned = utcToZonedTime(nowUTC, timezone)
  const today = DAYS[nowZoned.getDay()]
  const nowMinutes = getTodayMinutes(nowZoned)

  // Custom blocks first
  for (const block of customBlocks) {
    if (!block.enabled) continue
    if (!block.days.includes(today)) continue

    const start = block.startMinutes - bufferBefore
    const end = block.endMinutes + bufferAfter

    if (nowMinutes >= start && nowMinutes <= end) {
      return {
        status: 'Busy',
        validUntil: null
      }
    }
  }

  // Outlook blocks second
  for (const block of outlookBlocks) {
    const start = new Date(block.startISO)
    const end = new Date(block.endISO)

    if (
      isNowInBufferedRange(
        nowUTC,
        start,
        end,
        bufferBefore,
        bufferAfter
      )
    ) {
      return {
        status: 'Busy',
        validUntil: addMinutes(end, bufferAfter)
      }
    }
  }

  return {
    status: 'Available',
    validUntil: null
  }
}

module.exports = { computeStatus }
