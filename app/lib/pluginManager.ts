import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export class PluginManager {
    private buildEnv (): Record<string, string | undefined> {
        const env = { ...process.env }
        const registry = process.env.TLINK_NPM_REGISTRY ?? process.env.NPM_CONFIG_REGISTRY
        if (registry) {
            env.npm_config_registry = registry
        }
        const cafile = process.env.TLINK_NPM_CAFILE ?? process.env.NODE_EXTRA_CA_CERTS
        if (cafile) {
            env.npm_config_cafile = cafile
        }
        const strictSSL = process.env.TLINK_NPM_STRICT_SSL ?? process.env.NPM_CONFIG_STRICT_SSL
        if (strictSSL !== undefined) {
            const enabled = ['1', 'true', 'yes'].includes(String(strictSSL).toLowerCase())
            env.npm_config_strict_ssl = String(enabled)
        }
        return env
    }

    async install (path: string, name: string, version: string): Promise<void> {
        await execFileAsync('npm', ['install', '--no-save', `${name}@${version}`], {
            cwd: path,
            env: this.buildEnv(),
        })
    }

    async uninstall (path: string, name: string): Promise<void> {
        await execFileAsync('npm', ['uninstall', name], {
            cwd: path,
            env: this.buildEnv(),
        })
    }
}


export const pluginManager = new PluginManager()
