// models.js

class User {
  constructor({
    id,
    name,
    timezone,
    bufferBefore = 30,
    bufferAfter = 30
  }) {
    this.id = id
    this.name = name
    this.timezone = timezone
    this.bufferBefore = bufferBefore
    this.bufferAfter = bufferAfter
    this.outlookBlocks = []
    this.customBlocks = []
    this.manualOverride = null
  }
}

class OutlookBusyBlock {
  constructor({ startISO, endISO }) {
    this.startISO = startISO
    this.endISO = endISO
  }
}

class CustomBlock {
  constructor({
    type,
    startMinutes,
    endMinutes,
    days,
    enabled = true
  }) {
    this.type = type
    this.startMinutes = startMinutes
    this.endMinutes = endMinutes
    this.days = days
    this.enabled = enabled
  }
}

module.exports = {
  User,
  OutlookBusyBlock,
  CustomBlock
}
