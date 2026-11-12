import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import TelescopeDoctor from './telescope_doctor.js';

/**
 * The commands barrel for `@adonis-agora/telescope` (`agora:doctor`, `telescope:doctor`). Registered
 * in an app's `adonisrc` via `rcFile.addCommand('@adonis-agora/telescope/commands')`, which this
 * package's `configure` does.
 */
const loader = new ListLoader([AgoraDoctor, TelescopeDoctor]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);
