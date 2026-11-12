import type { AgoraDoctorCheck } from './agora_doctor.js';
import { telescopeDoctorChecks } from './checks.js';

export type {
  AgoraDoctorCheck,
  AgoraDoctorRegistry,
  AgoraDoctorReport,
  AgoraDoctorResult,
  AgoraDoctorStatus,
} from './agora_doctor.js';
export { AGORA_DOCTOR_BINDING, registerDoctorChecks } from './agora_doctor.js';
export {
  checkCsrf,
  checkDbSchema,
  checkGate,
  checkOtel,
  checkRetention,
  csrfBlocksPath,
  dbSchemaDoctorCheck,
  type OtelInstall,
  type SchemaInspectable,
  sdkLine,
} from './checks.js';

/** Every telescope check, for `node ace agora:doctor --no-boot` (which imports this entry). */
export const agoraDoctorChecks: AgoraDoctorCheck[] = telescopeDoctorChecks;
