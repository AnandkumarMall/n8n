import { render } from '@testing-library/vue';
import { describe, it, expect } from 'vitest';

import NodeTypeRestrictedPopover from './NodeTypeRestrictedPopover.vue';

describe('NodeTypeRestrictedPopover', () => {
	it('names the node and explains an instance restriction', () => {
		const { getByText, queryByRole } = render(NodeTypeRestrictedPopover, {
			props: {
				nodeDisplayName: 'Gmail',
				restriction: { name: 'n8n-nodes-base.gmail', available: false, scope: 'instance' },
			},
		});

		expect(getByText('Gmail')).toBeInTheDocument();
		expect(getByText('Restricted on this instance')).toBeInTheDocument();
		expect(getByText(/contact an instance administrator/)).toBeInTheDocument();
		expect(queryByRole('button')).not.toBeInTheDocument();
	});

	it('explains a project restriction', () => {
		const { getByText } = render(NodeTypeRestrictedPopover, {
			props: {
				nodeDisplayName: 'Gmail',
				restriction: { name: 'n8n-nodes-base.gmail', available: false, scope: 'project' },
			},
		});

		expect(getByText('Restricted in this project')).toBeInTheDocument();
		expect(getByText(/contact a project administrator/)).toBeInTheDocument();
	});
});
