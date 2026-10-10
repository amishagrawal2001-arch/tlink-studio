const { init } = String(process.type) === 'main' ? require('@sentry/electron/dist/main') : require('@sentry/electron/dist/renderer')

const SENTRY_DSN = 'https://4717a0a7ee0b4429bd3a0f06c3d7eec3@sentry.io/181876'
let release = null
try {
    release = require('electron').app.getVersion()
} catch {
    release = require('@electron/remote').app.getVersion()
}

// Default: Sentry disabled. Opt in with TLINK_ENABLE_SENTRY=1.
// Sentry hooks every exception/breadcrumb/perf-mark; disabling it eliminates
// a measurable packaged-vs-dev perf gap.
if (process.env.TLINK_ENABLE_SENTRY && !process.env.TLINK_DEV) {
    init({
        dsn: SENTRY_DSN,
        release,
        integrations (integrations) {
            return integrations.filter(integration => integration.name !== 'Breadcrumbs')
        },
    })
}
