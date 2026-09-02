// models.js

class User {
  constructor({
    id,
    name,
    timezone,
    bufferBefore = 15,
    bufferAfter = 15,
    manualOverride = null
  }) {
    this.id = id
    this.name = name
    this.timezone = timezone
    this.bufferBefore = bufferBefore
    this.bufferAfter = bufferAfter
    this.outlookBlocks = []
    this.customBlocks = []
    this.manualOverride = manualOverride
  }
}

class OutlookBusyBlock {
  constructor({ summary, startISO, endISO }) {
    this.summary = summary
    this.startISO = startISO
    this.endISO = endISO
  }
}

// A recurring weekly block (work, meals, sleep, workouts, ...).
// bufferBeforeMinutes/bufferAfterMinutes are per-block grace-period
// overrides - e.g. a bike ride needs a shower afterwards regardless of the
// user's default commute buffer. Leave them null to fall back to the
// user's global bufferBefore/bufferAfter.
class CustomBlock {
  constructor({
    type = 'custom',
    label,
    startMinutes,
    endMinutes,
    days,
    bufferBeforeMinutes = null,
    bufferAfterMinutes = null,
    enabled = true
  }) {
    this.type = type
    this.label = label || type
    this.startMinutes = startMinutes
    this.endMinutes = endMinutes
    this.days = days
    this.bufferBeforeMinutes = bufferBeforeMinutes
    this.bufferAfterMinutes = bufferAfterMinutes
    this.enabled = enabled
  }
}

module.exports = {
  User,
  OutlookBusyBlock,
  CustomBlock
}
