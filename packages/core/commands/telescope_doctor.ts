import AgoraDoctor from './agora_doctor.js';

/** `node ace telescope:doctor`: `agora:doctor` for telescope's checks only (same flags). */
export default class TelescopeDoctor extends AgoraDoctor {
  static override commandName = 'telescope:doctor';
  static override description = 'Check the @adonis-agora/telescope configuration';
  protected override presetLib: string | undefined = 'telescope';
}
