/** Errors parsers throw; the call maps them to failure categories. */

/** A parser found a response it does not recognise. */
export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeError';
  }
}

/** A 200 response without the data marker its parser expects: Airbnb served a page meant for bots. */
export class MarkerMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkerMissingError';
  }
}
