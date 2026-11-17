// The payment methods live in ./payments/ now — one module per method behind a shared
// PaymentMethod contract. This stays a re-export so every existing import path keeps
// working exactly as before.
export * from './payments/index.js';
