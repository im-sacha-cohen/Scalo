// "Quiet" context of a contact import: inside `withTriggersSuspended`, contact events are still written to the
// timeline but start nothing — no automation run is queued (`logEvent`) and a tag does not enroll the contact in the
// campaigns it triggers (`addTag`). An import must never send emails by surprise.
//
// AsyncLocalStorage (like the automation loop guard): the flag follows the async call chain of the import batch,
// including its transaction, and never leaks to concurrent requests.
import { AsyncLocalStorage } from 'node:async_hooks';

const quiet = new AsyncLocalStorage<boolean>();

export const triggersSuspended = () => quiet.getStore() === true;

export function withTriggersSuspended<T>(suspended: boolean, fn: () => Promise<T>): Promise<T> {
  return suspended ? quiet.run(true, fn) : fn();
}
