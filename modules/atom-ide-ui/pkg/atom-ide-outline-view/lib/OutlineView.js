/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import type {OutlineForUi, OutlineTreeForUi} from './createOutlines';
import type {TextToken} from 'nuclide-commons/tokenized-text';
import type {TreeNode, NodePath} from 'nuclide-commons-ui/SelectableTree';

import Atomicon, {getTypeFromIconName} from 'nuclide-commons-ui/Atomicon';
import HighlightedText from 'nuclide-commons-ui/HighlightedText';
import {arrayEqual} from 'nuclide-commons/collection';
import memoizeUntilChanged from 'nuclide-commons/memoizeUntilChanged';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';

import * as React from 'react';
import classnames from 'classnames';
import invariant from 'assert';
import nullthrows from 'nullthrows';

import matchIndexesToRanges from 'nuclide-commons/matchIndexesToRanges';
import analytics from 'nuclide-commons/analytics';
import {
  goToLocation,
  goToLocationInEditor,
} from 'nuclide-commons-atom/go-to-location';
import {
  LoadingSpinner,
  LoadingSpinnerSizes,
} from 'nuclide-commons-ui/LoadingSpinner';
import {EmptyState} from 'nuclide-commons-ui/EmptyState';
import {Tree} from 'nuclide-commons-ui/SelectableTree';

import type {SearchResult} from './OutlineViewSearch';
import {OutlineViewSearchComponent} from './OutlineViewSearch';

type State = {
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
};

type Props = {
  outline: OutlineForUi,
  visible: boolean,
};

const TOKEN_KIND_TO_CLASS_NAME_MAP = {
  keyword: 'syntax--keyword',
  'class-name': 'syntax--entity syntax--name syntax--class',
  constructor: 'syntax--entity syntax--name syntax--function',
  method: 'syntax--entity syntax--name syntax--function',
  param: 'syntax--variable',
  string: 'syntax--string',
  whitespace: '',
  plain: '',
  type: 'syntax--support syntax--type',
};

export class OutlineView extends React.PureComponent<Props, State> {
  _outlineViewRef: ?React.ElementRef<typeof OutlineViewComponent>;

  componentDidMount(): void {
    // Ensure that focus() gets called during the initial mount.
    if (this.props.visible) {
      this.focus();
    }
  }

  componentDidUpdate(prevProps: Props) {
    if (this.props.visible && !prevProps.visible) {
      this.focus();
    }
  }

  focus() {
    if (this._outlineViewRef != null) {
      this._outlineViewRef.focusSearch();
    }
  }

  _setOutlineViewRef = (
    element: ?React.ElementRef<typeof OutlineViewComponent>,
  ) => {
    this._outlineViewRef = element;
  };

  render(): React.Node {
    return (
      <div className="outline-view">
        <OutlineViewComponent
          outline={this.props.outline}
          ref={this._setOutlineViewRef}
        />
      </div>
    );
  }
}

type OutlineViewComponentProps = {
  outline: OutlineForUi,
};

class OutlineViewComponent extends React.PureComponent<
  OutlineViewComponentProps,
> {
  _outlineViewCoreRef: ?React.ElementRef<typeof OutlineViewCore>;

  constructor(props: OutlineViewComponentProps) {
    super(props);
  }

  _setOutlineViewCoreRef = element => {
    this._outlineViewCoreRef = element;
  };

  focusSearch() {
    if (this._outlineViewCoreRef != null) {
      this._outlineViewCoreRef.focusSearch();
    }
  }

  render(): React.Node {
    const {outline} = this.props;

    switch (outline.kind) {
      case 'empty':
      case 'not-text-editor':
        return (
          <EmptyState
            title="No outline available"
            message="Open a file to see its outline."
          />
        );
      case 'loading':
        return (
          <div className="outline-view-loading">
            <LoadingSpinner
              className="inline-block"
              size={LoadingSpinnerSizes.MEDIUM}
            />
          </div>
        );
      case 'no-provider':
        return outline.grammar === 'Null Grammar' ? (
          <EmptyState
            title="No outline available"
            message="Atom doesn't recognize this file's language. Make sure this file has an extension and has been saved."
          />
        ) : (
          <EmptyState
            title="No outline available"
            message={
              <div>
                {outline.grammar} files do not currently support outlines.{' '}
                <a
                  href="#"
                  onClick={() =>
                    goToLocation(
                      `atom://config/install/package:ide-${outline.grammar}`,
                    )
                  }>
                  Install an IDE package first.
                </a>
              </div>
            }
          />
        );
      case 'provider-no-outline':
        return (
          <EmptyState
            title="No outline available"
            message="This is likely an error with the language package."
          />
        );
      case 'outline':
        return (
          <OutlineViewCore
            outline={outline}
            ref={this._setOutlineViewCoreRef}
          />
        );
      default:
        (outline: empty);
    }
  }
}

type OutlineViewCoreProps = {
  outline: OutlineForUi,
};

/**
 * Contains both the search field and the scrollable outline tree
 */
class OutlineViewCore extends React.PureComponent<
  OutlineViewCoreProps,
  {
    searchResults: Map<OutlineTreeForUi, SearchResult>,
    collapsedPaths: Array<NodePath>,
  },
> {
  _scrollerNode: ?HTMLDivElement;
  _searchRef: ?React.ElementRef<typeof OutlineViewSearchComponent>;
  _subscriptions: ?UniversalDisposable;
  state = {
    collapsedPaths: [],
    searchResults: new Map(),
  };

  componentDidMount() {
    this._subscriptions = new UniversalDisposable(
      atom.commands.add(nullthrows(this._scrollerNode), 'atom-ide:filter', () =>
        this.focusSearch(),
      ),
    );
  }

  componentWillUnmount() {
    nullthrows(this._subscriptions).dispose();
  }

  _setScrollerNode = node => {
    this._scrollerNode = node;
  };

  _setSearchRef = element => {
    this._searchRef = element;
  };

  focusSearch() {
    if (this._searchRef != null) {
      this._searchRef.focus();
    }
  }

  _handleCollapse = (nodePath: NodePath) => {
    this.setState(prevState => {
      const existing = this.state.collapsedPaths.find(path =>
        arrayEqual(path, nodePath),
      );
      if (existing == null) {
        return {
          // TODO: (wbinnssmith) T30771435 this setState depends on current state
          // and should use an updater function rather than an object
          // eslint-disable-next-line react/no-access-state-in-setstate
          collapsedPaths: [...this.state.collapsedPaths, nodePath],
        };
      }
    });
  };

  _handleExpand = (nodePath: NodePath) => {
    this.setState(prevState => ({
      collapsedPaths: prevState.collapsedPaths.filter(
        path => !arrayEqual(path, nodePath),
      ),
    }));
  };

  _handleSelect = (nodePath: NodePath) => {
    analytics.track('atom-ide-outline-view:go-to-location');

    invariant(this.props.outline.kind === 'outline');
    const {editor} = this.props.outline;
    const outlineNode = selectNodeFromPath(this.props.outline, nodePath);

    const landingPosition =
      outlineNode.landingPosition != null
        ? outlineNode.landingPosition
        : outlineNode.startPosition;

    // single click moves the cursor, but does not focus the editor
    goToLocationInEditor(editor, {
      line: landingPosition.row,
      column: landingPosition.column,
    });
  };

  _handleConfirm = () => {
    this._focusEditor();
  };

  _handleTripleClick = (nodePath: NodePath) => {
    invariant(this.props.outline.kind === 'outline');
    const {editor} = this.props.outline;
    const outlineNode = selectNodeFromPath(this.props.outline, nodePath);

    // triple click selects the symbol's region
    const endPosition = outlineNode.endPosition;
    if (endPosition != null) {
      editor.selectToBufferPosition(endPosition);
    }
    this._focusEditor();
  };

  _focusEditor = () => {
    invariant(this.props.outline.kind === 'outline');
    const {editor} = this.props.outline;
    // double and triple clicks focus the editor afterwards
    const pane = atom.workspace.paneForItem(editor);
    if (pane == null) {
      return;
    }

    // Assumes that the click handler has already run, which moves the
    // cursor to the start of the symbol. Let's activate the pane now.
    pane.activate();
    pane.activateItem(editor);
  };

  _getNodes = memoizeUntilChanged(
    outlineTrees => outlineTrees.map(this._outlineTreeToNode),
    // searchResults is passed here as a cache key for the memoization.
    // Since tree nodes contain `hidden` within them, we need to rerender
    // whenever searchResults changes to reflect that.
    outlineTrees => [outlineTrees, this.state.searchResults],
  );

  _outlineTreeToNode = (outlineTree: OutlineTreeForUi): TreeNode => {
    const searchResult = this.state.searchResults.get(outlineTree);

    if (outlineTree.children.length === 0) {
      return {
        type: 'LEAF',
        label: renderItem(outlineTree),
        hidden: searchResult && !searchResult.visible,
      };
    }

    return {
      type: 'NESTED',
      label: renderItem(outlineTree),
      children: outlineTree.children.map(this._outlineTreeToNode),
      hidden: searchResult && !searchResult.visible,
    };
  };

  render() {
    const {outline} = this.props;
    invariant(outline.kind === 'outline');

    return (
      <div className="outline-view-core">
        <OutlineViewSearchComponent
          outlineTrees={outline.outlineTrees}
          editor={outline.editor}
          updateSearchResults={searchResults => {
            this.setState({searchResults});
          }}
          ref={this._setSearchRef}
        />
        <div
          className="outline-view-trees-scroller"
          ref={this._setScrollerNode}>
          <Tree
            className="outline-view-trees atom-ide-filterable"
            collapsedPaths={this.state.collapsedPaths}
            itemClassName="outline-view-item"
            items={this._getNodes(outline.outlineTrees)}
            onCollapse={this._handleCollapse}
            onConfirm={this._handleConfirm}
            onExpand={this._handleExpand}
            onSelect={this._handleSelect}
            onTripleClick={this._handleTripleClick}
            selectedPaths={outline.highlightedPaths}
          />
        </div>
      </div>
    );
  }
}

function renderItem(
  outline: OutlineTreeForUi,
  searchResult: ?SearchResult,
): React.Element<string> | string {
  const r = [];

  const iconName = outline.icon;
  if (iconName != null) {
    const correspondingAtomicon = getTypeFromIconName(iconName);
    if (correspondingAtomicon == null) {
      r.push(
        <span
          key="type-icon"
          className={classnames('icon', `icon-${iconName}`)}
        />,
      );
    } else {
      // If we're passed an icon name rather than a type, and it maps directly
      // to an atomicon, use that.
      r.push(<Atomicon key="type-icon" type={correspondingAtomicon} />);
    }
  } else if (outline.kind != null) {
    r.push(<Atomicon key="type-icon" type={outline.kind} />);
  }

  if (outline.tokenizedText != null) {
    let offset = 0;
    r.push(
      ...outline.tokenizedText.map((token, i) => {
        const toReturn = renderTextToken(token, i, searchResult, offset);
        offset += token.value.length;
        return toReturn;
      }),
    );
  } else if (outline.plainText != null) {
    const textWithMatching =
      searchResult && searchResult.matchingCharacters ? (
        <HighlightedText
          highlightedRanges={matchIndexesToRanges(
            searchResult.matchingCharacters,
          )}
          text={outline.plainText || ''}
        />
      ) : (
        outline.plainText
      );
    r.push(textWithMatching);
  } else {
    r.push('Missing text');
  }

  return <span>{r}</span>;
}

function renderTextToken(
  token: TextToken,
  index: number,
  searchResult: ?SearchResult,
  offset: number,
): React.Element<any> {
  const className = TOKEN_KIND_TO_CLASS_NAME_MAP[token.kind];
  return (
    <span className={className} key={index}>
      {searchResult && searchResult.matchingCharacters ? (
        <HighlightedText
          highlightedRanges={matchIndexesToRanges(
            searchResult.matchingCharacters
              .map(el => el - offset)
              .filter(el => el >= 0 && el < token.value.length),
          )}
          text={token.value}
        />
      ) : (
        token.value
      )}
    </span>
  );
}

function selectNodeFromPath(
  outline: OutlineForUi,
  path: NodePath,
): OutlineTreeForUi {
  invariant(outline.kind === 'outline');

  let node = outline.outlineTrees[path[0]];
  for (let i = 1; i < path.length; i++) {
    node = node.children[path[i]];
  }
  return node;
}
