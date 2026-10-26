import { getPool } from "../connection";
import { DeliveryService } from "./service";
import type { EnqueueInput, SenderKind } from "./types";

export * from "./types";
export { DeliveryService } from "./service";
export {
  runWorkerOnce,
  recordWorkerHeartbeat,
  recordWorkerSuccess,
} from "./worker";

const service = () => new DeliveryService(getPool());
export const enqueueCampaign = (input: EnqueueInput) =>
  service().enqueueCampaign(input);
export const getProgress = (ownerId: number, kind: SenderKind, id: number) =>
  service().getProgress(ownerId, kind, id);
export const cancelCampaign = (ownerId: number, kind: SenderKind, id: number) =>
  service().cancelCampaign(ownerId, kind, id);
export const resumeCampaign = (ownerId: number, kind: SenderKind, id: number) =>
  service().resumeCampaign(ownerId, kind, id);
export const getDeliveryLogs = (
  ownerId: number,
  kind: SenderKind,
  id: number,
  pagination?: { limit?: number; offset?: number }
) => service().getDeliveryLogs(ownerId, kind, id, pagination);
export const setContactPermission = (
  input: Parameters<DeliveryService["setContactPermission"]>[0]
) => service().setContactPermission(input);
export const listContactPermissions = (
  ownerId: number,
  kind: SenderKind,
  pagination?: { limit?: number; offset?: number }
) => service().listContactPermissions(ownerId, kind, pagination);
export const getSenderStatus = (ownerId: number, kind: SenderKind) =>
  service().getSenderStatus(ownerId, kind);
export const resumeSender = (ownerId: number, kind: SenderKind) =>
  service().resumeSender(ownerId, kind);
export const getWorkerStatus = () => service().getWorkerStatus();
export const resolveUnknown = (
  input: Parameters<DeliveryService["resolveUnknown"]>[0]
) => service().resolveUnknown(input);
