/**
 * Grid utilities for the radial canvas layout
 */
import { ProcessData } from '../../context/SocketContext';
import { BoxPosition } from '../../../../types';
import { X_OFFSET, Y_OFFSET } from '../../utils/constants';

// --- Constants ---
export const GRID_PADDING = 40; // Padding between grid cells
const VIEW_PADDING_Y = 300; // Default zoom padding for Y-axis
const VIEW_PADDING_X = 150; // Default zoom padding for X-axis
const SQUARE_MAX_WIDTH = 1000;
const SQUARE_MIN_WIDTH = 400;
const SQUARE_MAX_HEIGHT = 1400;
const SQUARE_MIN_HEIGHT = 400;
const CORE_SCALE = 2;
const DEFAULT_SCALE = 1;
const WORKER_SCALE = 0.5;

const HEAVY_AGENT_NAMES = ['browser', 'code', 'design'];

const isHeavyAgent = (name?: string): boolean =>
    !!name && HEAVY_AGENT_NAMES.some(t => name.toLowerCase().includes(t));

const MIN_ZOOM = 0.2; // Minimum allowed zoom level
const MAX_ZOOM = 2; // Maximum allowed zoom level

// --- Helper Functions ---

/** Creates a unique string key for a grid cell */
// Uncomment when needed
// const getGridKey = (row: number, col: number): string => `${row},${col}`;

export const getOrigin = (containerSize: {
    width: number;
    height: number;
}): {
    squareWidth: number;
    squareHeight: number;
    originX: number;
    originY: number;
} => {
    const containerWidth = X_OFFSET + containerSize.width;
    const containerHeight = Y_OFFSET + containerSize.height;

    // Calculate dynamic base dimensions for a 1x1 grid cell
    const squareWidth = Math.min(
        SQUARE_MAX_WIDTH,
        Math.max(SQUARE_MIN_WIDTH, Math.round(containerWidth * 0.8))
    );
    const squareHeight = Math.min(
        SQUARE_MAX_HEIGHT,
        containerHeight * 0.7,
        Math.max(
            SQUARE_MIN_HEIGHT,
            Math.round(
                squareWidth * Math.max(1, containerHeight / containerWidth)
            )
        )
    );

    // Calculate origin (top-left of the grid cell (0,0)) relative to viewport center
    const originX = X_OFFSET + containerSize.width / 2 - squareWidth / 2;
    const originY = Y_OFFSET + containerSize.height / 2 - squareHeight / 2;

    return {
        squareWidth,
        squareHeight,
        originX,
        originY,
    };
};

// --- Main Exported Functions ---

const hashString = (str: string): number => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash);
};

/**
 * Calculate positions for a radial star-cluster layout.
 * The core process is centered and all tasks orbit closely around it.
 * Workers of each task orbit their parent. Heavy workers (browser, code,
 * design) are rendered at full scale while lightweight workers are smaller.
 */
export const calculateBoxPositions = (
    coreProcessId: string,
    processes: Map<string, ProcessData>,
    containerSize: { width: number; height: number }
): Map<string, BoxPosition> => {
    if (processes.size === 0) return new Map<string, BoxPosition>();

    const positionsMap = new Map<string, BoxPosition>();
    const { squareWidth, squareHeight, originX, originY } =
        getOrigin(containerSize);

    const centerX = originX + squareWidth / 2;
    const centerY = originY + squareHeight / 2;

    const coreProcess = processes.get(coreProcessId);
    if (!coreProcess) {
        console.error(`Core process with ID ${coreProcessId} not found.`);
        return positionsMap;
    }

    positionsMap.set(coreProcessId, {
        x: centerX - squareWidth / 2,
        y: centerY - squareHeight / 2,
        width: squareWidth,
        height: squareHeight,
        scale: CORE_SCALE,
    });

    const taskIds: string[] = [];
    processes.forEach((_p, id) => {
        if (id !== coreProcessId) taskIds.push(id);
    });
    const coreWorkers = coreProcess.agent?.workers
        ? Array.from(coreProcess.agent.workers.keys())
        : [];
    taskIds.push(...coreWorkers);

    const sortedTasks = [...taskIds].sort(
        (a, b) => hashString(a) - hashString(b)
    );

    const taskRadius = squareWidth + GRID_PADDING * 1.5;

    sortedTasks.forEach((taskId, index) => {
        const angle = (index / sortedTasks.length) * 2 * Math.PI;
        const x = centerX + taskRadius * Math.cos(angle) - squareWidth / 2;
        const y = centerY + taskRadius * Math.sin(angle) - squareHeight / 2;
        positionsMap.set(taskId, {
            x,
            y,
            width: squareWidth,
            height: squareHeight,
            scale: DEFAULT_SCALE,
        });
    });

    processes.forEach((process, id) => {
        const parentPos = positionsMap.get(id);
        if (!parentPos || !process.agent?.workers) return;
        const workerEntries = Array.from(process.agent.workers.entries());
        if (workerEntries.length === 0) return;
        const sortedWorkers = workerEntries.sort(
            ([a], [b]) => hashString(a) - hashString(b)
        );
        const workerRadius = squareWidth + GRID_PADDING;
        sortedWorkers.forEach(([workerId, workerData], wIndex) => {
            if (positionsMap.has(workerId)) return;
            const angle = (wIndex / sortedWorkers.length) * 2 * Math.PI;
            const x =
                parentPos.x +
                parentPos.width / 2 +
                workerRadius * Math.cos(angle) -
                squareWidth / 2;
            const y =
                parentPos.y +
                parentPos.height / 2 +
                workerRadius * Math.sin(angle) -
                squareHeight / 2;
            positionsMap.set(workerId, {
                x,
                y,
                width: isHeavyAgent(workerData.name)
                    ? squareWidth
                    : squareWidth - GRID_PADDING / 2,
                height: isHeavyAgent(workerData.name)
                    ? squareHeight
                    : squareHeight - GRID_PADDING / 2,
                scale: isHeavyAgent(workerData.name)
                    ? DEFAULT_SCALE
                    : WORKER_SCALE,
            });
        });
    });

    return positionsMap;
};

/**
 * Calculate bounding box for all positions, consistently using scale.
 */
export const calculateBoundingBox = (
    positions: Map<string, BoxPosition>
): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} => {
    let minX = Number.POSITIVE_INFINITY,
        minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY,
        maxY = Number.NEGATIVE_INFINITY;

    if (positions.size === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    for (const pos of positions.values()) {
        const visualWidth = pos.width * pos.scale;
        const visualHeight = pos.height * pos.scale;

        const boxMinX = pos.x;
        const boxMinY = pos.y;
        const boxMaxX = pos.x + visualWidth;
        const boxMaxY = pos.y + visualHeight;

        minX = Math.min(minX, boxMinX);
        minY = Math.min(minY, boxMinY);
        maxX = Math.max(maxX, boxMaxX);
        maxY = Math.max(maxY, boxMaxY);
    }

    // Add fallback logic if calculation results in invalid bounds
    if (!Number.isFinite(minX + minY + maxX + maxY)) {
        console.warn(
            'Bounding box calculation resulted in non-finite values. Resetting to origin.'
        );
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }

    return { minX, minY, maxX, maxY };
};

/**
 * Calculate zoom and translation to fit items in the viewport.
 */
export const calculateZoomToFit = (
    boxPositions: Map<string, BoxPosition>,
    containerSize: { width: number; height: number }
): { zoom: number; translateX: number; translateY: number } => {
    if (boxPositions.size === 0) {
        return { zoom: 2, translateX: 0, translateY: 0 };
    }

    const { minX, minY, maxX, maxY } = calculateBoundingBox(boxPositions);
    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;

    // Handle single item or zero area content
    if (
        contentWidth <= 0 ||
        contentHeight <= 0 ||
        !Number.isFinite(contentWidth + contentHeight)
    ) {
        if (
            boxPositions.size === 1 &&
            Number.isFinite(contentWidth + contentHeight)
        ) {
            // Uncomment when needed
            // const position = boxPositions.values().next().value;
            // Use bounding box center for single item as well
            const contentCenterX = minX + contentWidth / 2;
            const contentCenterY = minY + contentHeight / 2;

            // Base zoom primarily on visual size relative to container, less on scale property itself
            const zoomFitX =
                containerSize.width /
                Math.max(1, contentWidth + 2 * GRID_PADDING);
            const zoomFitY =
                containerSize.height /
                Math.max(1, contentHeight + 2 * GRID_PADDING);
            let zoom = Math.min(zoomFitX, zoomFitY);

            zoom = Math.min(Math.max(zoom, MIN_ZOOM), 0.5); // Clamp

            const viewportCenterX = X_OFFSET + containerSize.width / 2;
            const viewportCenterY = Y_OFFSET + containerSize.height / 2;
            const translateX = viewportCenterX - contentCenterX * zoom;
            const translateY = viewportCenterY - contentCenterY * zoom;
            return { zoom, translateX, translateY };
        } else {
            console.warn(
                'Zoom calculation: Zero area content or non-finite bounds, returning default view.'
            );
            return { zoom: 1, translateX: 0, translateY: 0 }; // Default view
        }
    }

    // Calculate padded bounds for multiple items
    const paddedMinX = minX - VIEW_PADDING_X;
    const paddedMinY = minY - VIEW_PADDING_Y;
    const paddedMaxX = maxX + VIEW_PADDING_X;
    const paddedMaxY = maxY + VIEW_PADDING_Y;
    const paddedContentWidth = Math.max(1, paddedMaxX - paddedMinX); // Ensure > 0
    const paddedContentHeight = Math.max(1, paddedMaxY - paddedMinY); // Ensure > 0

    // Calculate zoom
    const zoomX = containerSize.width / paddedContentWidth;
    const zoomY = containerSize.height / paddedContentHeight;
    let zoom = Math.min(zoomX, zoomY);
    zoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM); // Clamp

    // Calculate translation
    const viewportCenterX = X_OFFSET + containerSize.width / 2;
    const viewportCenterY = Y_OFFSET + containerSize.height / 2;
    const contentCenterX = paddedMinX + paddedContentWidth / 2;
    const contentCenterY = paddedMinY + paddedContentHeight / 2;
    const translateX = viewportCenterX - contentCenterX * zoom;
    const translateY = viewportCenterY - contentCenterY * zoom;

    return { zoom, translateX, translateY };
};
