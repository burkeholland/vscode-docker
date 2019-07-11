/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ProcessProvider } from "./ChildProcessProvider";

export type MSBuildExecOptions = {
    target?: string;
    properties?: { [key: string]: string };
};

export interface DotNetClient {
    execTarget(projectFile: string, options?: MSBuildExecOptions): Promise<void>;
    getVersion(): Promise<string | undefined>;
    trustAndExportCertificate(projectFile: string, hostExportPath: string, containerExportPath: string, password: string): Promise<void>;
}

export class CommandLineDotNetClient implements DotNetClient {
    constructor(private readonly processProvider: ProcessProvider) {
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

    public async trustAndExportCertificate(projectFile: string, hostExportPath: string, containerExportPath: string, password: string): Promise<void> {
        // TODO : skip this for projects where it has already been done
        // TODO : trust doesn't work for Linux users; need to direct them to manually fixing

        const exportCommand = `dotnet dev-certs https --trust -ep "${hostExportPath}" -p "${password}"`;
        await this.processProvider.exec(exportCommand, {});

        const userSecretsPasswordCommand = `dotnet user-secrets --project "${projectFile}" set Kestrel:Certificates:Development:Password "${password}"`;
        await this.processProvider.exec(userSecretsPasswordCommand, {});

        // This is not honored due to https://github.com/aspnet/AspNetCore.Docs/issues/6199#issuecomment-418194220
        //const userSecretsPathCommand = `dotnet user-secrets --project "${projectFile}" set Kestrel:Certificates:Development:Path "${containerExportPath}"`;
        //await this.processProvider.exec(userSecretsPathCommand, {});
    }
}

export default CommandLineDotNetClient;
