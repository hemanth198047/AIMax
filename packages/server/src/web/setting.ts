import { getSetting } from '../providers/usage.js';
/** Reading pasted links is on by default; Settings → Local connections can turn it off. */
export const linkReadingOn = () => getSetting<boolean>('link_reading', true) !== false;
