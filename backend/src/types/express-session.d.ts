/**
 * Session fields for the site an operator is working on.
 *
 * A separate file from `express.d.ts` because this one has to `import
 * 'express-session'` to augment its module, and adding that import to
 * `express.d.ts` would turn that ambient script into a module and silently drop
 * the global `Request.correlationId` augmentation.
 *
 * The current site lives here rather than being derived from the WLC config
 * table: it is a property of this operator's session, not of the controller.
 * Deriving it meant two operators on different sites shared one flag, and a
 * browser refresh could restore the wrong site entirely.
 */
import 'express-session';

declare module 'express-session' {
  interface SessionData {
    /** Site this operator selected. Absent means they still have to choose. */
    sedeId?: number;
    /**
     * Whether this operator's own WLC connect succeeded. UI state: it says
     * nothing about the controller's health, only about this session.
     */
    wlcConnected?: boolean;
  }
}
