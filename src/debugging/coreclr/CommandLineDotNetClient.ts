/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as crypto from 'crypto';
import * as os from 'os';
import * as semver from 'semver';
import { MessageItem } from 'vscode';
import { DialogResponses, parseError } from 'vscode-azureextensionui';
import { ext } from '../../extensionVariables';
import { ProcessProvider } from "./ChildProcessProvider";
import { FileSystemProvider } from "./fsProvider";
import { OSProvider } from "./LocalOSProvider";

export type MSBuildExecOptions = {
    target?: string;
    properties?: { [key: string]: string };
};

export interface DotNetClient {
    execTarget(projectFile: string, options?: MSBuildExecOptions): Promise<void>;
    getVersion(): Promise<string | undefined>;
    trustAndExportSslCertificate(projectFile: string, hostExportPath: string): Promise<void>;
}

export class CommandLineDotNetClient implements DotNetClient {
    private static _KnownConfiguredProjects: Set<string> = new Set<string>();
    private static _CertificateTrustedOrSkipped: boolean = false;

    constructor(
        private readonly processProvider: ProcessProvider,
        private readonly fsProvider: FileSystemProvider,
        private readonly osProvider: OSProvider) {
    }

    public async execTarget(projectFile: string, options?: MSBuildExecOptions): Promise<void> {
        let command = `dotnet msbuild "${projectFile}"`;

        if (options) {
            if (options.target) {
                command += ` "/t:${options.target}"`;
            }

            if (options.properties) {
                const properties = options.properties;

                command += Object.keys(properties).map(key => ` "/p:${key}=${properties[key]}"`).join('');
            }
        }

        await this.processProvider.exec(command, {});
    }

    public async getVersion(): Promise<string | undefined> {
        try {

            const command = `dotnet --version`;

            const result = await this.processProvider.exec(command, {});

            return result.stdout.trim();
        } catch {
            return undefined;
        }
    }

    public async trustAndExportSslCertificate(projectFile: string, hostExportPath: string): Promise<void> {
        if (CommandLineDotNetClient._KnownConfiguredProjects.has(projectFile)) {
            return;
        }

        await this.addUserSecretsIfNecessary(projectFile);
        await this.promptAndTrustCertificateIfNecessary();
        await this.exportAndSetPasswordIfNecessary(projectFile, hostExportPath);

        // Cache the project so we don't do this all over again every F5
        CommandLineDotNetClient._KnownConfiguredProjects.add(projectFile);
    }

    private async addUserSecretsIfNecessary(projectFile: string): Promise<void> {
        const contents = await this.fsProvider.readFile(projectFile);

        if (/UserSecretsId/i.test(contents)) {
            return;
        }

        const dotNetVer = await this.getVersion();
        if (semver.gte(dotNetVer, '3.0.0')) {
            const userSecretsInitCommand = `dotnet user-secrets init --project "${projectFile}" --id ${this.getRandomHexString(32)}`;
            await this.processProvider.exec(userSecretsInitCommand, {});
        }
    }

    private async promptAndTrustCertificateIfNecessary(): Promise<void> {
        if (this.osProvider.os !== 'Windows' && !this.osProvider.isMac) {
            // No centralized notion of trust on Linux
            return;
        }

        if (CommandLineDotNetClient._CertificateTrustedOrSkipped) {
            return;
        }

        try {
            const checkCommand = `dotnet dev-certs https --check --trust`;
            await this.processProvider.exec(checkCommand, {});
            CommandLineDotNetClient._CertificateTrustedOrSkipped = true;
        } catch (err) {
            const error = parseError(err);

            if (error.errorType === '6' || error.errorType === '7') { // 6 = certificate not found, 7 = certificate not trusted
                const trust: MessageItem = { title: 'Trust' };
                const prompt = this.osProvider.os === 'Windows' ? 'A prompt may be shown.' : 'You may be prompted for your login password.';
                const message = `The ASP.NET Core HTTPS development certificate is not trusted. Would you like to trust the certificate? ${prompt}`;

                const selection = await ext.ui.showWarningMessage(
                    message,
                    { modal: true, learnMoreLink: 'https://aka.ms/vscode-docker-dev-certs' },
                    trust, DialogResponses.skipForNow);

                if (selection === trust) {
                    const trustCommand = `${this.osProvider.os === 'Windows' ? '' : 'sudo -S '}dotnet dev-certs https --trust`;
                    let attempts = 0;

                    await this.processProvider.exec(trustCommand, {
                        progress: async (output, process) => {
                            if (this.osProvider.os === 'Windows') {
                                return;
                            }

                            if (/Password:/i.test(output)) {
                                const passwordPrompt = attempts++ < 1 ? 'Please enter your login password.' : 'Sorry, please enter your login password again.';
                                const password = await ext.ui.showInputBox({ prompt: passwordPrompt, password: true });
                                process.stdin.write(password);
                                process.stdin.write(os.EOL);
                            }
                        }
                    });

                    CommandLineDotNetClient._CertificateTrustedOrSkipped = true;
                } else {
                    CommandLineDotNetClient._CertificateTrustedOrSkipped = true;
                }
            } else { throw err; }
        }
    }

    private async exportAndSetPasswordIfNecessary(projectFile: string, hostExportPath: string): Promise<void> {
        if (await this.fsProvider.fileExists(hostExportPath)) {
            return;
        }

        try {
            const password = this.getRandomHexString(32);

            // Export the certificate
            const exportCommand = `dotnet dev-certs https -ep "${hostExportPath}" -p "${password}"`;
            await this.processProvider.exec(exportCommand, {});

            // Set the password to dotnet user-secrets
            const userSecretsPasswordCommand = `dotnet user-secrets --project "${projectFile}" set Kestrel:Certificates:Development:Password "${password}"`;
            await this.processProvider.exec(userSecretsPasswordCommand, {});
        } catch (err) {
            if (await this.fsProvider.fileExists(hostExportPath)) {
                await this.fsProvider.unlinkFile(hostExportPath);
            }

            throw err;
        }
    }

    private getRandomHexString(length: number): string {
        const buffer: Buffer = crypto.randomBytes(Math.ceil(length / 2));
        return buffer.toString('hex').slice(0, length);
    }
}

export default CommandLineDotNetClient;
