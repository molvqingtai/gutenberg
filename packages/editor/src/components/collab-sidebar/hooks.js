/**
 * WordPress dependencies
 */
import { __ } from '@wordpress/i18n';
import {
	useState,
	useEffect,
	useMemo,
	useSyncExternalStore,
} from '@wordpress/element';
import { useEntityRecords, store as coreStore } from '@wordpress/core-data';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
import {
	store as blockEditorStore,
	privateApis as blockEditorPrivateApis,
} from '@wordpress/block-editor';
import { store as noticesStore } from '@wordpress/notices';
import { getScrollContainer } from '@wordpress/dom';
import { decodeEntities } from '@wordpress/html-entities';
import { store as interfaceStore } from '@wordpress/interface';

/**
 * Internal dependencies
 */
import { store as editorStore } from '../../store';
import { FLOATING_NOTES_SIDEBAR } from './constants';
import { unlock } from '../../lock-unlock';
import { createBoardStore } from './board-store';
import { calculateNotePositions } from './utils';

const { cleanEmptyObject } = unlock( blockEditorPrivateApis );

export function useBlockComments( postId ) {
	const queryArgs = {
		post: postId,
		type: 'note',
		status: 'all',
		per_page: -1,
	};

	const { records: threads } = useEntityRecords(
		'root',
		'comment',
		queryArgs,
		{ enabled: !! postId && typeof postId === 'number' }
	);

	const { getBlockAttributes } = useSelect( blockEditorStore );
	const { clientIds } = useSelect( ( select ) => {
		const { getClientIdsWithDescendants } = select( blockEditorStore );
		return {
			clientIds: getClientIdsWithDescendants(),
		};
	}, [] );

	// Process comments to build the tree structure.
	const { resultComments, unresolvedSortedThreads } = useMemo( () => {
		if ( ! threads || threads.length === 0 ) {
			return { resultComments: [], unresolvedSortedThreads: [] };
		}

		const blocksWithComments = clientIds.reduce( ( results, clientId ) => {
			const commentId = getBlockAttributes( clientId )?.metadata?.noteId;
			if ( commentId ) {
				results[ clientId ] = commentId;
			}
			return results;
		}, {} );

		// Create a compare to store the references to all objects by id.
		const compare = {};
		const result = [];

		// Create a reverse map for faster lookup.
		const commentIdToBlockClientId = Object.keys(
			blocksWithComments
		).reduce( ( mapping, clientId ) => {
			mapping[ blocksWithComments[ clientId ] ] = clientId;
			return mapping;
		}, {} );

		// Initialize each object with an empty `reply` array and map blockClientId.
		threads.forEach( ( item ) => {
			const itemBlock = commentIdToBlockClientId[ item.id ];

			compare[ item.id ] = {
				...item,
				reply: [],
				blockClientId: item.parent === 0 ? itemBlock : null,
			};
		} );

		// Iterate over the data to build the tree structure.
		threads.forEach( ( item ) => {
			if ( item.parent === 0 ) {
				// If parent is 0, it's a root item, push it to the result array.
				result.push( compare[ item.id ] );
			} else if ( compare[ item.parent ] ) {
				// Otherwise, find its parent and push it to the parent's `reply` array.
				compare[ item.parent ].reply.push( compare[ item.id ] );
			}
		} );

		if ( 0 === result?.length ) {
			return { resultComments: [], unresolvedSortedThreads: [] };
		}

		const updatedResult = result.map( ( item ) => ( {
			...item,
			reply: [ ...item.reply ].reverse(),
		} ) );

		const threadIdMap = new Map(
			updatedResult.map( ( thread ) => [ String( thread.id ), thread ] )
		);

		// Prepare sets to determine which threads are linked to existing blocks.
		const mappedIds = new Set(
			Object.values( blocksWithComments ).map( ( id ) => String( id ) )
		);

		// Get comments by block order, first unresolved, then resolved.
		const unresolvedSortedComments = Object.values( blocksWithComments )
			.map( ( commentId ) => threadIdMap.get( String( commentId ) ) )
			.filter(
				( thread ) => thread !== undefined && thread.status === 'hold'
			);

		const resolvedSortedComments = Object.values( blocksWithComments )
			.map( ( commentId ) => threadIdMap.get( String( commentId ) ) )
			.filter(
				( thread ) =>
					thread !== undefined && thread.status === 'approved'
			);

		// Append orphaned notes (whose related block was deleted or missing).
		const orphanedComments = updatedResult.filter(
			( thread ) => ! mappedIds.has( String( thread.id ) )
		);

		const allSortedComments = [
			...unresolvedSortedComments,
			...resolvedSortedComments,
			...orphanedComments,
		];

		return {
			resultComments: allSortedComments,
			unresolvedSortedThreads: unresolvedSortedComments,
		};
	}, [ clientIds, threads, getBlockAttributes ] );

	return {
		resultComments,
		unresolvedSortedThreads,
	};
}

export function useBlockCommentsActions() {
	const { createNotice } = useDispatch( noticesStore );
	const { saveEntityRecord, deleteEntityRecord } = useDispatch( coreStore );
	const { getCurrentPostId } = useSelect( editorStore );
	const { getBlockAttributes, getSelectedBlockClientId } =
		useSelect( blockEditorStore );
	const { updateBlockAttributes } = useDispatch( blockEditorStore );

	const onError = ( error ) => {
		const errorMessage =
			error.message && error.code !== 'unknown_error'
				? decodeEntities( error.message )
				: __( 'An error occurred while performing an update.' );
		createNotice( 'error', errorMessage, {
			type: 'snackbar',
			isDismissible: true,
		} );
	};

	const onCreate = async ( { content, parent } ) => {
		try {
			const savedRecord = await saveEntityRecord(
				'root',
				'comment',
				{
					post: getCurrentPostId(),
					content,
					status: 'hold',
					type: 'note',
					parent: parent || 0,
				},
				{ throwOnError: true }
			);

			// If it's a main comment, update the block attributes with the comment id.
			if ( ! parent && savedRecord?.id ) {
				const clientId = getSelectedBlockClientId();
				const metadata = getBlockAttributes( clientId )?.metadata;
				updateBlockAttributes( clientId, {
					metadata: {
						...metadata,
						noteId: savedRecord.id,
					},
				} );
			}

			createNotice(
				'snackbar',
				parent ? __( 'Reply added.' ) : __( 'Note added.' ),
				{
					type: 'snackbar',
					isDismissible: true,
				}
			);
			return savedRecord;
		} catch ( error ) {
			onError( error );
		}
	};

	const onEdit = async ( { id, content, status } ) => {
		const messageType = status ? status : 'updated';
		const messages = {
			approved: __( 'Note marked as resolved.' ),
			hold: __( 'Note reopened.' ),
			updated: __( 'Note updated.' ),
		};

		try {
			// For resolution or reopen actions, create a new note with metadata.
			if ( status === 'approved' || status === 'hold' ) {
				// First, update the thread status.
				await saveEntityRecord(
					'root',
					'comment',
					{
						id,
						status,
					},
					{
						throwOnError: true,
					}
				);

				// Then create a new comment with the metadata.
				const newCommentData = {
					post: getCurrentPostId(),
					content: content || '', // Empty content for resolve, content for reopen.
					type: 'note',
					status,
					parent: id,
					meta: {
						_wp_note_status:
							status === 'approved' ? 'resolved' : 'reopen',
					},
				};

				await saveEntityRecord( 'root', 'comment', newCommentData, {
					throwOnError: true,
				} );
			} else {
				const updateData = {
					id,
					content,
					status,
				};

				await saveEntityRecord( 'root', 'comment', updateData, {
					throwOnError: true,
				} );
			}

			createNotice(
				'snackbar',
				messages[ messageType ] ?? __( 'Note updated.' ),
				{
					type: 'snackbar',
					isDismissible: true,
				}
			);
		} catch ( error ) {
			onError( error );
		}
	};

	const onDelete = async ( comment ) => {
		try {
			await deleteEntityRecord(
				'root',
				'comment',
				comment.id,
				undefined,
				{
					throwOnError: true,
				}
			);

			if ( ! comment.parent ) {
				const clientId = getSelectedBlockClientId();
				const metadata = getBlockAttributes( clientId )?.metadata;
				updateBlockAttributes( clientId, {
					metadata: cleanEmptyObject( {
						...metadata,
						noteId: undefined,
					} ),
				} );
			}

			createNotice( 'snackbar', __( 'Note deleted.' ), {
				type: 'snackbar',
				isDismissible: true,
			} );
		} catch ( error ) {
			onError( error );
		}
	};

	return { onCreate, onEdit, onDelete };
}

export function useEnableFloatingSidebar( enabled = false ) {
	const registry = useRegistry();
	useEffect( () => {
		if ( ! enabled ) {
			return;
		}

		const { getActiveComplementaryArea } =
			registry.select( interfaceStore );
		const { disableComplementaryArea, enableComplementaryArea } =
			registry.dispatch( interfaceStore );

		const unsubscribe = registry.subscribe( () => {
			// Return `null` to indicate the user hid the complementary area.
			if ( getActiveComplementaryArea( 'core' ) === null ) {
				enableComplementaryArea( 'core', FLOATING_NOTES_SIDEBAR );
			}
		} );

		return () => {
			unsubscribe();
			if (
				getActiveComplementaryArea( 'core' ) === FLOATING_NOTES_SIDEBAR
			) {
				disableComplementaryArea( 'core', FLOATING_NOTES_SIDEBAR );
			}
		};
	}, [ enabled, registry ] );
}

export function useFloatingBoard( {
	threads,
	selectedNoteId,
	isFloating,
	commentSidebarRef,
} ) {
	const [ notePositions, setNotePositions ] = useState( {} );
	const [ contentHeight, setContentHeight ] = useState( 0 );
	const [ store ] = useState( createBoardStore );

	const heights = useSyncExternalStore( store.subscribe, store.getSnapshot );

	// Positions are computed with scrollTop baked in; the panel mirrors the
	// editor's scroll so notes track their blocks without per-frame recalc.
	useEffect( () => {
		if ( ! isFloating || ! commentSidebarRef?.current ) {
			return;
		}

		const panel = commentSidebarRef.current;
		const blockEl = store.getFirstBlockElement();
		// Start from the block-list root so nested-block scroll containers
		// (e.g. a Group with overflow:auto) don't shadow the editor canvas.
		// If `.is-root-container` ever moves or is unavailable, consider
		// threading `contentRef` down from VisualEditor instead.
		const rootEl = blockEl?.closest( '.is-root-container' ) ?? blockEl;
		const canvas = rootEl ? getScrollContainer( rootEl ) : null;

		const rafId = window.requestAnimationFrame( () => {
			const result = calculateNotePositions( {
				threads,
				selectedNoteId,
				blockRects: store.getBlockRects(),
				heights,
				scrollTop: canvas?.scrollTop ?? 0,
			} );

			setNotePositions( result.positions );
			setContentHeight( result.contentHeight );

			if ( canvas ) {
				panel.scrollTop = canvas.scrollTop;
			}
		} );

		const onScroll = () => {
			panel.scrollTop = canvas.scrollTop;
		};

		// Scroll events on root scrolling elements (documentElement/body) don't
		// fire on the element itself; capture on the window catches them reliably
		// across iframe and non-iframe canvases.
		const view = canvas?.ownerDocument?.defaultView;
		view?.addEventListener( 'scroll', onScroll, {
			passive: true,
			capture: true,
		} );

		return () => {
			window.cancelAnimationFrame( rafId );
			view?.removeEventListener( 'scroll', onScroll, {
				capture: true,
			} );
		};
	}, [
		commentSidebarRef,
		heights,
		isFloating,
		selectedNoteId,
		store,
		threads,
	] );

	return {
		notePositions,
		contentHeight,
		registerThread: store.registerThread,
		unregisterThread: store.unregisterThread,
	};
}
