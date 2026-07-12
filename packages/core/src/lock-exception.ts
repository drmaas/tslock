export class LockException extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LockException';
  }
}

export class NoActiveLockException extends LockException {
  constructor(message = 'No active lock in current async context') {
    super(message);
    this.name = 'NoActiveLockException';
  }
}

export class LockCanNotBeExtendedException extends LockException {
  constructor(message = 'Lock can not be extended') {
    super(message);
    this.name = 'LockCanNotBeExtendedException';
  }
}
