export abstract class OtpDelivery {
  abstract send(destination: string, code: string): Promise<void>;
}
