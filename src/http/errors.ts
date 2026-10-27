export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string
  ) {
    super(message || code);
    this.name = 'AppError';
  }
}

export class InsufficientFundsError extends Error {
  constructor(message?: string) {
    super(message || 'Insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}
