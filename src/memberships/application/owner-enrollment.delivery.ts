export abstract class OwnerEnrollmentDelivery {
  abstract send(destination: string, setupToken: string): Promise<void>;
}
