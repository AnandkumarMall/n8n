import { describe, it, expect, beforeEach } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import userEvent from '@testing-library/user-event';

import { createComponentRenderer } from '@/__tests__/render';
import NodeSettingsRestrictedCallout from './NodeSettingsRestrictedCallout.vue';

const renderComponent = createComponentRenderer(NodeSettingsRestrictedCallout, {
	props: { nodeTypeName: 'Slack' },
	global: {
		stubs: {
			ContactInstanceAdminModal: {
				props: ['open', 'description'],
				template:
					'<div v-if="open" data-test-id="contact-instance-admin-modal">{{ description }}</div>',
			},
		},
	},
});

describe('NodeSettingsRestrictedCallout', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia());
	});

	it('names the node type and the blocking scope', () => {
		const { getByTestId } = renderComponent({ props: { scope: 'instance' } });

		expect(getByTestId('node-restricted-callout')).toHaveTextContent(
			"An administrator blocked 'Slack' on this instance.",
		);
	});

	it('renders an unknown scope generically', () => {
		const { getByTestId } = renderComponent({ props: { scope: 'folder' } });

		expect(getByTestId('node-restricted-callout')).toHaveTextContent(
			"An administrator blocked 'Slack'.",
		);
	});

	it('opens the contact-admin dialog with copy for this node type', async () => {
		const { getByTestId, queryByTestId } = renderComponent();

		expect(queryByTestId('contact-instance-admin-modal')).not.toBeInTheDocument();
		await userEvent.click(getByTestId('node-restricted-contact-admin'));

		expect(getByTestId('contact-instance-admin-modal')).toHaveTextContent("access to 'Slack'");
	});

	it('emits replaceNode from the replace action', async () => {
		const { getByTestId, emitted } = renderComponent();

		await userEvent.click(getByTestId('node-restricted-replace'));

		expect(emitted('replaceNode')).toHaveLength(1);
	});
});
