export type ApiJsonPrimitive = null | string | number | boolean;

export type ApiJsonValue =
  | ApiJsonPrimitive
  | readonly ApiJsonValue[]
  | { readonly [key: string]: ApiJsonValue };

export type ApiJsonObject = Readonly<Record<string, ApiJsonValue>>;

export interface FinancialApiPort {
  createDepositQuote(input: unknown): Promise<ApiJsonObject>;
  createWithdrawalQuote(input: unknown): Promise<ApiJsonObject>;
  submitDepositIntent(input: unknown, idempotencyKey: string): Promise<ApiJsonObject>;
  submitWithdrawalIntent(input: unknown, idempotencyKey: string): Promise<ApiJsonObject>;
  submitDepositFunding(
    operationId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<ApiJsonObject>;
  getOperation(operationId: string): Promise<ApiJsonObject>;
  createBasket(input: unknown): Promise<ApiJsonObject>;
}

export class ApiRequestError extends Error {
  public constructor(
    public readonly statusCode: 400 | 401 | 404 | 409 | 422 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}
