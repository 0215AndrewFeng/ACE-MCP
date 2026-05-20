export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public override readonly cause?: Error;

  public constructor(
    code: string,
    message: string,
    options?: { cause?: Error; retryable?: boolean; statusCode?: number },
  ) {
    super(message);
    this.code = code;
    this.name = "AppError";
    this.statusCode = options?.statusCode ?? AppError.inferStatusCode(code);
    this.retryable = options?.retryable ?? false;
    this.cause = options?.cause;
  }

  private static inferStatusCode(code: string): number {
    switch (code) {
      case "INVALID_PROJECT_ROOT":
      case "INVALID_QUERY":
      case "INVALID_STRUCTURED_QUERY":
        return 400;
      case "PROJECT_NOT_INDEXED":
      case "PROJECT_NOT_FOUND":
        return 404;
      default:
        return 500;
    }
  }
}
