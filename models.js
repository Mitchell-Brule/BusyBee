// engine/models.js

class User {
  constructor({ id, name, timezone, bufferBefore = 30, bufferAfter = 30 }) {
    this.id = id
    this.name = name
    this.timezone = timezone
    this.bufferBefore = bufferBefore // in minutes
    this.bufferAfter = bufferAfter
    this.outlookBlocks = [] // list of OutlookBusyBlock
    this.customBlocks = []  // list of CustomBlock
    this.manualOverride = null // e.g., 'DND'
  }
}

class OutlookBusyBlock {
  constructor({ start, end }) {
    this.start = new Date(start)
    this.end = new Date(end)
  }
}

class CustomBlock {
  constructor({ type, start, end, days = [], recurring = false }) {
    this.type = type
    this.start = new Date(start)
    this.end = new Date(end)
    this.days = days // ['Mon', 'Wed']
    this.recurring = recurring
  }
}

module.exports = { User, OutlookBusyBlock, CustomBlock }
