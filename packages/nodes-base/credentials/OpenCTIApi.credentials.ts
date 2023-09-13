import type { IAuthenticateGeneric, ICredentialType, INodeProperties } from 'n8n-workflow';

export class OpenCTIApi implements ICredentialType {
	name = 'openCtiApi';

	displayName = 'OpenCTI API';

	documentationUrl = 'opencti';

	icon = 'file:icons/OpenCTI.png';

	httpRequestNodeVariant = {
		docsUrl: 'https://docs.opencti.io/latest/deployment/integrations/?h=api#graphql-api',
		apiBaseUrl: '',
	};

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};
}
