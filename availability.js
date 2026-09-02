// availability.js
const { addMinutes, addDays, isBefore, isAfter, differenceInMinutes } = require('date-fns')
const { toZonedTime, fromZonedTime } = require('date-fns-tz')

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// If a person is currently busy but free again within this many minutes,
// report "Available Soon" instead of flat "Busy" - the Teams-style nuance
// the whole point of this engine is to surface.
const SOON_THRESHOLD_MINUTES = 15

// zonedNow is a Date produced by toZonedTime: reading it with the local
// Date getters (getHours/getMinutes/getDay) yields wall-clock time in the
// target zone. This builds another such "fake-local" Date at a given
// minute-of-day offset from the same day, so it can be fed straight into
// fromZonedTime to get a real UTC instant back.
function zonedDateAt(zonedNow, minutesFromMidnight) {
    const d = new Date(zonedNow)
    d.setHours(0, 0, 0, 0)
    d.setMinutes(minutesFromMidnight)
    return d
}

// A recurring block scheduled on specific weekdays can span midnight (a
// sleep block from 23:00 to 07:00). To catch "it's 2am, still in last
// night's block" we have to check both the instance anchored on *today*
// and the one anchored on *yesterday*.
function findActiveCustomBlock(customBlocks, nowUTC, nowZoned, timezone, defaultBefore, defaultAfter) {
    const today = DAYS[nowZoned.getDay()]
    const yesterdayZoned = addDays(nowZoned, -1)
    const yesterday = DAYS[yesterdayZoned.getDay()]

    let best = null

    for (const block of customBlocks) {
        if (!block.enabled) continue

        const before = block.bufferBeforeMinutes ?? defaultBefore
        const after = block.bufferAfterMinutes ?? defaultAfter
        const wraps = block.endMinutes <= block.startMinutes

        const anchors = []
        if (block.days.includes(today)) anchors.push(nowZoned)
        if (block.days.includes(yesterday)) anchors.push(yesterdayZoned)

        for (const anchor of anchors) {
            const startZoned = zonedDateAt(anchor, block.startMinutes)
            const endZoned = zonedDateAt(anchor, wraps ? block.endMinutes + 1440 : block.endMinutes)

            const bufferedStartUTC = fromZonedTime(addMinutes(startZoned, -before), timezone)
            const bufferedEndUTC = fromZonedTime(addMinutes(endZoned, after), timezone)

            if (isAfter(nowUTC, bufferedStartUTC) && isBefore(nowUTC, bufferedEndUTC)) {
                if (!best || isAfter(bufferedEndUTC, best.validUntil)) {
                    best = { label: block.label, validUntil: bufferedEndUTC }
                }
            }
        }
    }

    return best
}

function findActiveImportedEvent(outlookBlocks, nowUTC, defaultBefore, defaultAfter) {
    let best = null

    for (const block of outlookBlocks) {
        const start = new Date(block.startISO)
        const end = new Date(block.endISO)
        const bufferedStart = addMinutes(start, -defaultBefore)
        const bufferedEnd = addMinutes(end, defaultAfter)

        if (isAfter(nowUTC, bufferedStart) && isBefore(nowUTC, bufferedEnd)) {
            if (!best || isAfter(bufferedEnd, best.validUntil)) {
                best = { label: block.summary || 'Busy', validUntil: bufferedEnd }
            }
        }
    }

    return best
}

// Returns { status, validUntil, reason }
// status is one of: 'DND', 'Busy', 'Available Soon', 'Available'
function computeStatus(user, nowUTC = new Date()) {
    const {
        timezone,
        bufferBefore,
        bufferAfter,
        outlookBlocks = [],
        customBlocks = [],
        manualOverride
    } = user

    if (manualOverride) {
        return { status: manualOverride, validUntil: null, reason: 'Manually set' }
    }

    const nowZoned = toZonedTime(nowUTC, timezone)

    const customHit = findActiveCustomBlock(customBlocks, nowUTC, nowZoned, timezone, bufferBefore, bufferAfter)
    const importedHit = findActiveImportedEvent(outlookBlocks, nowUTC, bufferBefore, bufferAfter)

    // Whichever active block keeps them busy longest wins - that's the
    // real "next available" time.
    let active = customHit
    if (importedHit && (!active || isAfter(importedHit.validUntil, active.validUntil))) {
        active = importedHit
    }

    if (!active) {
        return { status: 'Available', validUntil: null, reason: null }
    }

    const minutesUntilFree = differenceInMinutes(active.validUntil, nowUTC)
    const status = minutesUntilFree <= SOON_THRESHOLD_MINUTES ? 'Available Soon' : 'Busy'

    return { status, validUntil: active.validUntil, reason: active.label }
}

module.exports = { computeStatus, SOON_THRESHOLD_MINUTES }
