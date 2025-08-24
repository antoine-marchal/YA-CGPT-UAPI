export class Mutex {
  constructor() {
    this.locked = false;
    this.queue = [];
  }

  async acquire() {
    if (!this.locked) {
      this.locked = true;
      return this._release.bind(this);
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  _release() {
    const next = this.queue.shift();
    if (next) next(this._release.bind(this));
    else this.locked = false;
  }
}