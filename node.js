const path = require("path");
const grpc = require("grpc");
const users = require("./data/tinyUsers.json");
const protoLoader = require("@grpc/proto-loader");
const minimist = require("minimist");
const { Worker } = require("worker_threads");

const PROTO_PATH = path.resolve(__dirname, "./protos/chord.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});

const chord = grpc.loadPackageDefinition(packageDefinition).chord;

const caller = require("grpc-caller");

const HASH_BIT_LENGTH = 3;

const NULL_NODE = { id: null, ip: null, port: null };

let FingerTable = [
    {
        start: null,
        successor: NULL_NODE
    }
];

let SuccessorTable = [
    { successor: NULL_NODE }
]

let _self = NULL_NODE;

let predecessor = NULL_NODE;

function isInModuloRange(input_value, lower_bound, include_lower, upper_bound, include_upper) {
    /*
        USAGE
        include_lower == true means [lower_bound, ...
        include_lower == false means (lower_bound, ...
        include_upper == true means ..., upper_bound]
        include_upper == false means ..., upper_bound)
    */
    if (include_lower && include_upper) {
        if (lower_bound > upper_bound) {
            //looping through 0
            return (input_value >= lower_bound || input_value <= upper_bound);
        } else {
            return (input_value >= lower_bound && input_value <= upper_bound);
        }
    } else if (include_lower && !include_upper) {
        if (lower_bound > upper_bound) {
            //looping through 0
            return (input_value >= lower_bound || input_value < upper_bound);
        } else {
            return (input_value >= lower_bound && input_value < upper_bound);
        }
    } else if (!include_lower && include_upper) {
        if (lower_bound > upper_bound) {
            //looping through 0
            return (input_value > lower_bound || input_value <= upper_bound);
        } else {
            // start < end
            return (input_value > lower_bound && input_value <= upper_bound);
        }
    } else {
        //include neither
        if (lower_bound > upper_bound) {
            //looping through 0
            return (input_value > lower_bound || input_value < upper_bound);
        } else {
            // start < end
            return (input_value > lower_bound && input_value < upper_bound);
        }
    }
}

function summary(_, callback) {
    console.log("vvvvv     vvvvv     Summary     vvvvv     vvvvv");
    console.log("FingerTable: \n", FingerTable);
    console.log("Predecessor: ", predecessor);
    console.log("^^^^^     ^^^^^     End Summary     ^^^^^     ^^^^^")
    callback(null, _self);
}

function fetch({ request: { id } }, callback) {
    console.log(`Requested User ${id}`);
    if (!users[id]) {
        callback({ code: 5 }, null); // NOT_FOUND error
    } else {
        callback(null, users[id]);
    }
}

function insert({ request: user }, callback) {
    if (users[user.id]) {
        const message = `Err: ${user.id} already exits`;
        console.log(message);
        callback({ code: 6, message }, null); // ALREADY_EXISTS error
    } else {
        users[user.id] = user;
        const message = `Inserted User ${user.id}:`;
        console.log(message);
        callback({ status: 0, message }, null);
    }
}

/* added 20191102 */
async function find_successor(id, node_querying, node_queried) {
    /**
     * Directly implement the pseudocode's find_successor() method.
     * However, it is able to discern whether to do a local lookup or an RPC.
     * If the querying node is the same as the queried node, it will stay local.
     */
    // enable debugging output
    const DEBUGGING_LOCAL = false;

    let n_prime_successor;

    /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
    if (DEBUGGING_LOCAL) {
        console.log("vvvvv     vvvvv     find_successor     vvvvv     vvvvv");
    }
    /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */
    if (node_querying.id == node_queried.id) {
        // use local value
        // n' = find_predecessor(id);
        let n_prime = await find_predecessor(id);

        /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
        if (DEBUGGING_LOCAL) {
            console.log("find_successor: n_prime is ", n_prime.id);
        }
        /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */

        // get n'.successor either locally or remotely
        n_prime_successor = await getSuccessor(id, _self, n_prime);
    } else {
        // create client for remote call
        const node_queried_client = caller(`localhost:${node_queried.port}`, PROTO_PATH, "Node");
        // now grab the remote value
        try {
            n_prime_successor = await node_queried_client.find_successor_remotehelper({ id: id, node: node_queried });
        } catch (err) {
            console.error("remote helper error in find_successor() ", err);
        }
    }

    /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
    if (DEBUGGING_LOCAL) {
        console.log("find_successor: n_prime_successor = ", n_prime_successor.id);
        console.log("^^^^^     ^^^^^     find_successor     ^^^^^     ^^^^^");
    }
    /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */

    // return n'.successor;
    return n_prime_successor;
}

/* added 20191019 */
async function find_successor_remotehelper(id_and_node_queried, callback) {
    /** 
     * RPC equivalent of the pseudocode's find_successor() method.
     * It is implemented as simply a wrapper for the local find_successor() method.
     */
    const id = id_and_node_queried.request.id;
    const node_queried = id_and_node_queried.request.node;
    let n_prime_successor = await find_successor(id, _self, node_queried);
    callback(null, n_prime_successor);
}

/* added 20191023 */
async function find_predecessor(id) {
    /** 
     * This function directly implements the pseudocode's find_predecessor() method with the exception of the limits on the while loop.
     * 
    */
    // enable debugging output
    const DEBUGGING_LOCAL = false;

    /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
    if (DEBUGGING_LOCAL) {
        console.log("vvvvv     vvvvv     find_predecessor     vvvvv     vvvvv");
        console.log("id = ", id);
    }
    /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */

    // n' = n;
    let n_prime = _self;
    let prior_n_prime = { id: null, ip: null, port: null };
    let n_prime_successor = await getSuccessor(id, _self, n_prime);

    /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
    if (DEBUGGING_LOCAL) {
        console.log("before while: n_prime = ", n_prime.id, "; n_prime_successor = ", n_prime_successor.id);
    }
    /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */

    // (maximum chord nodes = 2^m) * (length of finger table = m)
    let iteration_counter = 2 ** HASH_BIT_LENGTH * HASH_BIT_LENGTH;
    // while (id 'not-in' (n', n'.successor] )
    while (!(isInModuloRange(id, n_prime.id, false, n_prime_successor.id, true))
        && (n_prime.id !== n_prime_successor.id)
        // && (n_prime.id !== prior_n_prime.id)
        && (iteration_counter >= 0)) {
        // loop should exit if n' and its successor are the same
        // loop should exit if n' and the prior n' are the same
        // loop should exit if the iterations are ridiculous
        // update loop protection
        iteration_counter--;
        // n' = n'.closest_preceding_finger(id);
        n_prime = await closest_preceding_finger(id, _self, n_prime);

        /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
        if (DEBUGGING_LOCAL) {
            console.log("=== while iteration ", iteration_counter, " ===");
            console.log("n_prime = ", n_prime);
        }
        /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */

        n_prime_successor = await getSuccessor(id, _self, n_prime);
        // store state
        prior_n_prime = n_prime;

        /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
        if (DEBUGGING_LOCAL) {
            console.log("n_prime_successor = ", n_prime_successor);
        }
        /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */

    }

    /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
    if (DEBUGGING_LOCAL) {
        console.log("^^^^^     ^^^^^     find_predecessor     ^^^^^     ^^^^^");
    }
    /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */

    // return n';
    return n_prime;
}

/**
 * Return the successor of a given node ID by either a local lookup or an RPC.
 * If the querying node is the same as the queried node, it will be a local lookup.
 * 
 * @returns : the successor if the successor seems valid, or a null node otherwise
 * @version 20191103
 */
async function getSuccessor(id, node_querying, node_queried) {
    // enable debugging output
    const DEBUGGING_LOCAL = false;

    if (DEBUGGING_LOCAL) {
        console.log("vvvvv     vvvvv     getSuccessor     vvvvv     vvvvv");
        console.log("id = ", id, "; node_querying is ", node_querying, "; node being queried is ", node_queried);
    }

    // get n.successor either locally or remotely
    let n_successor = NULL_NODE;
    if (node_querying.id == node_queried.id) {
        // use local value
        n_successor = FingerTable[0].successor;
    } else {
        // use remote value
        // create client for remote call
        const node_queried_client = caller(`localhost:${node_queried.port}`, PROTO_PATH, "Node");
        // now grab the remote value
        try {
            n_successor = await node_queried_client.getSuccessor_remotehelper(node_queried);
        } catch (err) {
            console.error("Remote error in getSuccessor() ", err);
            n_successor = NULL_NODE;
        }
    }

    if (DEBUGGING_LOCAL) {
        console.log("returning n_successor = ", n_successor);
        console.log("^^^^^     ^^^^^     getSuccessor     ^^^^^     ^^^^^");
    }

    return n_successor;
}

/** 
 * RPC equivalent of the getSuccessor() method.
 * It is implemented as simply a wrapper for the getSuccessor() function.
 * 
 * @version 20191103
 */
async function getSuccessor_remotehelper(thing, callback) {
    callback(null, FingerTable[0].successor);
}

/* modified 20191102 */
async function closest_preceding_finger(id, node_querying, node_queried) {
    /**
     * Directly implement the pseudocode's closest_preceding_finger() method.
     * However, it is able to discern whether to do a local lookup or an RPC.
     * If the querying node is the same as the queried node, it will stay local.
     */
    let n_preceding;
    if (node_querying.id == node_queried.id) {
        // use local value
        // for i = m downto 1
        for (let i = HASH_BIT_LENGTH - 1; i >= 0; i--) {
            // if ( finger[i].node 'is-in' (n, id) )
            if (isInModuloRange(FingerTable[i].successor.id, node_queried.id, false, id, false)) {
                // return finger[i].node;
                n_preceding = FingerTable[i].successor;
                return n_preceding;
            }
        }
        // return n;
        n_preceding = node_queried;
        return n_preceding;
    } else {
        // use remote value
        // create client for remote call
        const node_queried_client = caller(`localhost:${node_queried.port}`, PROTO_PATH, "Node");
        // now grab the remote value
        try {
            n_preceding = await node_queried_client.closest_preceding_finger_remotehelper({ id: id, node: node_queried });
        } catch (err) {
            console.error("remote helper error in closest_preceding_finger() ", err);
        }
        // return n;
        return n_preceding;
    }
}

/* added 20191019 */
async function closest_preceding_finger_remotehelper(id_and_node_queried, callback) {
    /** 
     * RPC equivalent of the pseudocode's closest_preceding_finger() method.
     * It is implemented as simply a wrapper for the local closest_preceding_finger() function.
     */
    const id = id_and_node_queried.request.id;
    const node_queried = id_and_node_queried.request.node;
    const n_preceding = await closest_preceding_finger(id, _self, node_queried);
    callback(null, n_preceding);
}

async function getPredecessor(thing, callback) {
    callback(null, predecessor);
}

/* modified 20191019 */
// TODO: Determine proper use of RC0 with gRPC
//  /*{status: 0, message: "OK"}*/
function setPredecessor(message, callback) {
    /**
     * RPC to replace the value of the node's predecessor.
     */
    // enable debugging output
    const DEBUGGING_LOCAL = false;

    /* vvvvv     vvvvv     debugging code     vvvvv     vvvvv */
    if (DEBUGGING_LOCAL) {
        console.log("vvvvv     vvvvv     setPredecessor     vvvvv     vvvvv");
        console.log("Self = ", _self);
        console.log("Self's original predecessor = ", predecessor);
    }
    /* ^^^^^     ^^^^^     debugging code     ^^^^^     ^^^^^ */

    predecessor = message.request; //message.request is node

    /* vvvvv     vvvvv     debugging code     vvvvv     vvvvv */
    if (DEBUGGING_LOCAL) {
        console.log("Self's new predecessor = ", predecessor);
        console.log("^^^^^     ^^^^^     setPredecessor     ^^^^^     ^^^^^");
    }
    /* ^^^^^     ^^^^^     debugging code     ^^^^^     ^^^^^ */

    callback(null, {});
}


/**
 * Modified implementation of pseudocode's "heavyweight" version of the join() method 
 *   as described in Figure 6 of the SIGCOMM paper.
 * Modification consists of an additional step of initializing the successor table
 *   as described in the IEEE paper.
 * 
 * @argument known_node: known_node structure; e.g., {id, ip, port}
 *   Pass a null known node to force the node to be the first in a new chord.
 * @version 20191103
 */
async function join(known_node) {
    // enable debugging output
    const DEBUGGING_LOCAL = true;
    // remove dummy template initializer from table
    FingerTable.pop();
    // initialize table with reasonable values
    for (let i = 0; i < HASH_BIT_LENGTH; i++) {
        FingerTable.push({
            start: (_self.id + 2 ** i) % (2 ** HASH_BIT_LENGTH),
            successor: _self
        });
    }
    // if (n')
    if (known_node && confirm_exist(known_node)) {
        // (n');
        await init_finger_table(known_node);
        // update_others();
        await update_others();
    } else {
        // this is the first node
        // initialize predecessor
        predecessor = _self;
    }

    // TODO migrate keys: (predecessor, n]; i.e., (predecessor, _self]
    await migrate_keys();

    // initialize successor table - deviates from SIGCOMM
    SuccessorTable[0].successor = FingerTable[0].successor;
    // initialize rest of table with dummy values
    for (let i = 1; i < HASH_BIT_LENGTH; i++) {
        SuccessorTable.push({
            successor: { id: null, ip: null, port: null }
        });
    }

    if (DEBUGGING_LOCAL) {
        console.log(">>>>>     join          ");
        console.log("The FingerTable[] leaving {", _self.id, "}.join(", known_node.id, ") is:\n", FingerTable);
        console.log("The {", _self.id, "}.predecessor leaving join() is ", predecessor);
        console.log("          join     <<<<<\n");
    }
}

function confirm_exist(known_node) {
    /**
     * Determine whether a node exists by pinging it.
     */
    // TODO: confirm_exist actually needs to ping the endpoint to ensure it's real
    return !(_self.id == known_node.id);
}

/* modified 20191021 */
async function init_finger_table(n_prime) {
    /**
     * Directly implement the pseudocode's init_finger_table() method.
     */
    // enable debugging output
    const DEBUGGING_LOCAL = false;

    /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
    if (DEBUGGING_LOCAL) {
        console.log("vvvvv     vvvvv     init_finger_table     vvvvv     vvvvv");
        console.log("self = ", _self.id, "; self.successor = ", FingerTable[0].successor.id, "; finger[0].start = ", FingerTable[0].start);
        console.log("n' = ", n_prime.id);
    }
    /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */

    let n_prime_successor;
    try {
        n_prime_successor = await find_successor(FingerTable[0].start, _self, n_prime);
    } catch (err) {
        console.error("find_successor error in init_finger_table() ", err);
    }
    // finger[1].node = n'.find_successor(finger[1].start);
    FingerTable[0].successor = n_prime_successor;

    /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
    if (DEBUGGING_LOCAL) {
        console.log("n'.successor (now  self.successor) = ", n_prime_successor);
    }
    /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */

    // client for newly-determined successor
    let successor_client = caller(`localhost:${FingerTable[0].successor.port}`, PROTO_PATH, "Node");
    // predecessor = successor.predecessor;
    try {
        predecessor = await successor_client.getPredecessor(FingerTable[0].successor);
    } catch (err) {
        console.error("getPredecessor() error in init_finger_table() ", err);
    }
    // successor.predecessor = n;
    try {
        await successor_client.setPredecessor(_self);
    } catch (err) {
        console.error("setPredecessor() error in init_finger_table() ", err);
    }

    /* vvvvv     vvvvv     TBD debugging code     vvvvv     vvvvv */
    if (DEBUGGING_LOCAL) {
        console.log("init_finger_table: predecessor  ", predecessor);
    }
    /* ^^^^^     ^^^^^     TBD debugging code     ^^^^^     ^^^^^ */

    // for (i=1 to m-1){}, where 1 is really 0, and skip last element
    for (let i = 0; i < HASH_BIT_LENGTH - 1; i++) {
        // if ( finger[i+1].start 'is in' [n, finger[i].node) )
        if (isInModuloRange(FingerTable[i + 1].start, _self.id, true, FingerTable[i].successor.id, false)) {
            // finger[i+1].node = finger[i].node;
            FingerTable[i + 1].successor = FingerTable[i].successor;
        } else {
            // finger[i+1].node = n'.find_successor(finger[i+1].start);
            try {
                FingerTable[i + 1].successor = await find_successor(FingerTable[i + 1].start, _self, n_prime);
            } catch (err) {
                console.error("find_successor error in init_finger_table ", err);
            }
        }
    }
    if (DEBUGGING_LOCAL) {
        console.log("init_finger_table: FingerTable[] =\n", FingerTable);
        console.log("^^^^^     ^^^^^     init_finger_table     ^^^^^     ^^^^^");
    }
}

/**
 * Directly implement the pseudocode's update_others() method.
 * 
 * @version 20191102
 */
async function update_others() {
    // enable debugging output
    const DEBUGGING_LOCAL = false;
    if (DEBUGGING_LOCAL) {
        console.log("vvvvv     vvvvv     update_others     vvvvv     vvvvv");
        console.log("_self = ", _self);
    }

    let p_node;
    let p_node_search_id;
    let p_node_client;
    // for i = 1 to m
    for (let i = 0; i < HASH_BIT_LENGTH; i++) {
        /* argument for "p = find_predecessor(n - 2^(i - 1))"
            but really 2^(i) because the index is now 0-based
            nonetheless, avoid ambiguity with negative numbers by:
                1- pegging 0 to 2^m with "+ 2**HASH_BIT_LENGTH
                2- taking the mod with "% 2**HASH_BIT_LENGTH"
        */
        p_node_search_id = (_self.id - 2 ** i + 2 ** HASH_BIT_LENGTH) % (2 ** HASH_BIT_LENGTH);
        if (DEBUGGING_LOCAL) {
            console.log("i = ", i, "; find_predecessor(", p_node_search_id, ") --> p_node");
        }

        // p = find_predecessor(n - 2^(i - 1));
        try {
            p_node = await find_predecessor(p_node_search_id);
        } catch (err) {
            console.error("\nError from find_predecessor(", p_node_search_id, ") in update_others().\n");
        }
        if (DEBUGGING_LOCAL) {
            console.log("p_node = ", p_node);
        }

        // p.update_finger_table(n, i);
        if (_self.id !== p_node.id) {
            p_node_client = caller(`localhost:${p_node.port}`, PROTO_PATH, "Node");
            try {
                await p_node_client.update_finger_table({ node: _self, index: i });
            } catch (err) {
                console.log(`localhost:${p_node.port}`);
                console.error("update_others: client.update_finger_table error ", err);
            }
        }
    }

    if (DEBUGGING_LOCAL) {
        console.log("^^^^^     ^^^^^     update_others     ^^^^^     ^^^^^");
    }
}

/**
 * RPC that directly implements the pseudocode's update_finger_table() method.
 * 
 * @argument message : consists of {s_node, finger_index} * 
 * @version 20191102
 */
async function update_finger_table(message, callback) {
    // enable debugging output
    const DEBUGGING_LOCAL = false;

    const s_node = message.request.node;
    const finger_index = message.request.index;

    if (DEBUGGING_LOCAL) {
        console.log("vvvvv     vvvvv     update_finger_table     vvvvv     vvvvv");
        console.log("{", _self.id, "}.FingerTable[] =\n", FingerTable);
        console.log("s_node = ", message.request.node.id, "; finger_index =", finger_index);
    }

    // if ( s 'is in' [n, finger[i].node) )
    if (isInModuloRange(s_node.id, _self.id, true, FingerTable[finger_index].successor.id, false)) {
        // finger[i].node = s;
        FingerTable[finger_index].successor = s_node;
        // p = predecessor;
        const p_client = caller(`localhost:${predecessor.port}`, PROTO_PATH, "Node");
        // p.update_finger_table(s, i);
        try {
            await p_client.update_finger_table({ node: s_node, index: finger_index });
        } catch (err) {
            console.error("Error updating the finger table of {", s_node.id, "}.\n\n", err);
        }

        if (DEBUGGING_LOCAL) {
            console.log("Updated {", _self.id, "}.FingerTable[", finger_index, "] to ", s_node);
            console.log("^^^^^     ^^^^^     update_finger_table     ^^^^^     ^^^^^");
        }

        // TODO: Figure out how to determine if the above had an RC of 0
        // If so call callback({status: 0, message: "OK"}, {});
        callback(null, {});
        return;
    }

    if (DEBUGGING_LOCAL) {
        console.log("^^^^^     ^^^^^     update_finger_table     ^^^^^     ^^^^^");
    }

    // TODO: Figure out how to determine if the above had an RC of 0
    //callback({ status: 0, message: "OK" }, {});
    callback(null, {});
}

/**
 * Update fault-tolerance structure discussed in E.3 'Failure and Replication' of IEEE paper.
 * 
 * "Node reconciles its list with its successor by: 
 *      [1-] copying successor's successor list, 
 *      [2-] removing its last entry, 
 *      [3-] and prepending to it.
 * If node notices that its successor has failed, 
 *      [1-] it replaces it with the first live entry in its successor list 
 *      [2-] and reconciles its successor list with its new successor."
 * 
 * @returns : true if it was successful; false otherwise.
 * @version 20191103
 */
async function update_successor_table() {
    // enable debugging output
    const DEBUGGING_LOCAL = true;
    if (DEBUGGING_LOCAL) {
        console.log("vvvvv     vvvvv     update_successor_table     vvvvv     vvvvv");
        console.log("{", _self.id, "}.SuccessorTable[] =\n", SuccessorTable);
        console.log("s_node = ", FingerTable[0].successor.id);
    }
    // check for error in table
    if (SuccessorTable.length !== HASH_BIT_LENGTH) {
        if (DEBUGGING_LOCAL) {
            console.log("Malformed SuccessorTable[]: expected length ", HASH_BIT_LENGTH, 
                " but actual length is ", SuccessorTable.length, ".");
        }
        return false;
    }
    // check whether the successor is available
    try {
        successor_seems_ok = await check_successor();
    } catch (err) {
        successor_seems_ok = false;
    }
    // check whether 
    while ((!successor_seems_ok) && (SuccessorTable.length > 0)) {
        // try again, to account for contention or bad luck
        try {
            successor_seems_ok = await check_successor();
        } catch (err) {
            successor_seems_ok = false;
        }
        if (!successor_seems_ok) {
            // drop the first successor candidate
            SuccessorTable.shift();
            // update the finger table
            FingerTable[0].successor = SuccessorTable[0];
        }
    }

    if (DEBUGGING_LOCAL) {
        console.log("^^^^^     ^^^^^     update_successor_table     ^^^^^     ^^^^^");
    }
    return true;
}

/**
 * Return the successor table of a node ID by either a local lookup or an RPC.
 * If the querying node is the same as the queried node, it will be a local lookup.
 * 
 * @returns : the successor table if the successor seems valid, or a null table otherwise
 * @version 20191103
 */
async function getSuccessorTable(node_querying, node_queried) {
    // enable debugging output
    const DEBUGGING_LOCAL = true;

    if (DEBUGGING_LOCAL) {
        console.log("vvvvv     vvvvv     getSuccessorTable     vvvvv     vvvvv");
        console.log("node_querying is ", node_querying, "; node being queried is ", node_queried);
    }

    // get n.SuccessorTable either locally or remotely
    let n_successor_table = [NULL_NODE];
    if (node_querying.id == node_queried.id) {
        // use local value
        n_successor_table = SuccessorTable;
    } else {
        // use remote value
        // create client for remote call
        const node_queried_client = caller(`localhost:${node_queried.port}`, PROTO_PATH, "Node");
        // now grab the remote value
        try {
            n_successor_table = await node_queried_client.getSuccessorTable_remotehelper(node_queried);
        } catch (err) {
            console.error("Remote error in getSuccessorTable() ", err);
            n_successor_table = [NULL_NODE];
        }
    }

    if (DEBUGGING_LOCAL) {
        console.log("returning n_successor_table = ", n_successor_table);
        console.log("^^^^^     ^^^^^     getSuccessorTable     ^^^^^     ^^^^^");
    }

    return n_successor_table;
}

/** 
 * RPC equivalent of the getSuccessorTable() method.
 * It is implemented as simply a wrapper for the getSuccessorTable() function.
 * 
 * @version 20191103
 */
async function getSuccessorTable_remotehelper(thing, callback) {
    callback(null, SuccessorTable);
}

/**
 * Modified implementation of pseudocode's stabilize() method
 *   as described in Figure 7 of the SIGCOMM paper.
 * Modifications consist:
 *  1- additional logic to stabilize a node whose predecessor is itself
 *      as would be the case for the initial node in a chord.
 *  2- additional step of updating the successor table as recommended by the IEEE paper.
 *
 * @version 20191103
 */
async function stabilize() {
    // enable debugging output
    const DEBUGGING_LOCAL = true;

    let x;
    let successor_client = caller(`localhost:${FingerTable[0].successor.port}`, PROTO_PATH, "Node");
    // x = successor.predecessor;
    if (FingerTable[0].successor.id == _self.id) {
        // use local value
        await stabilize_self();
        x = _self;
    } else {
        // use remote value
        try {
            x = await successor_client.getPredecessor(FingerTable[0].successor);
        } catch (err) {
            x = _self;
            console.log("Warning! \"successor.predecessor\" (i.e., {", 
                FingerTable[0].successor.id, "}.predecessor), failed in stabilize({", _self.id, "}).");
            // TODO: consider looping through the rest of the fingers or asking the predecessor.
        }
    }

    // if (x 'is in' (n, n.successor))
    if (isInModuloRange(x.id, _self.id, false, FingerTable[0].successor.id, false)) {
        // successor = x;
        FingerTable[0].successor = x;
    }

    if (DEBUGGING_LOCAL) {
        console.log(">>>>>     stabilize          ");
        console.log("{", _self.id, "}.FingerTable[] leaving stabilize() is:\n", FingerTable);
        console.log("{", _self.id, "}.predecessor is ", predecessor);
        console.log("          stabilize     <<<<<");
    }

    // successor.notify(n);
    if (_self.id !== FingerTable[0].successor.id) {
        successor_client = caller(`localhost:${FingerTable[0].successor.port}`, PROTO_PATH, "Node");
        try {
            await successor_client.notify(_self);
        } catch (err) {
            // no need for handler
        }
    }

    // update successor table - deviates from SIGCOMM
    try {
        await update_successor_table();
    } catch (err) {
        // probably no need for error handler
    }
}

/**
 * Attempts to kick a node with a successor of self, as would be the case in the first node in a chord.
 * The kick comes from setting the successor to be equal to the predecessor.
 * 
 * This is an original function, not described in either version of the paper - added 20191021.
 *
 * @returns : true if it was a good kick; false if bad kick.
 * @version 20191103
*/
async function stabilize_self() {
    let other_node_client;
    if (predecessor.id == null) {
        // this node is in real trouble since its predecessor is no good either
        // TODO try to rescue it by stepping through the rest of its finger table, else destroy it
        return false;
    }
    if (predecessor.id !== _self.id) {
        other_node_client = caller(`localhost:${predecessor.port}`, PROTO_PATH, "Node");
        try {
            // confirm that the predecessor is actually there
            await other_node_client.getPredecessor(_self);
            // then kick by setting the successor to the same as the predecessor
            FingerTable[0].successor = predecessor;
        } catch (err) {
            console.error(err);
        }
    } else {
        console.log("\nWarning: {", _self.id, "} is isolated because",
            "predecessor is", predecessor.id,
            "and successor is", FingerTable[0].successor.id, ".");
        return false;
    }
    return true;
}

/* modified 20191021 */
async function notify(message, callback) {
    /**
     * Directly implements the pseudocode's notify() method.
     */
    const n_prime = message.request;
    // if (predecessor is nil or n' 'is in' (predecessor, n))
    if ((predecessor.id == null)
        || isInModuloRange(n_prime.id, predecessor.id, false, _self.id, false)) {
        // predecessor = n';
        predecessor = n_prime;
    }
    callback(null, {});
}

/* modified 20191022 */
async function fix_fingers() {
    /**
     * Directly implements the pseudocode's fix_fingers() method.
     */
    // enable debugging output
    const DEBUGGING_LOCAL = false;

    // i = random index > 1 into finger[]; but really >0 because 0-based
    // random integer within the range (0, m)
    const i = Math.ceil(Math.random() * (HASH_BIT_LENGTH - 1));
    // finger[i].node = find_successor(finger[i].start);
    FingerTable[i].successor = await find_successor(FingerTable[i].start, _self, _self);
    if (DEBUGGING_LOCAL) {
        console.log("\n>>>>>     Fix {", _self.id, "}.FingerTable[", i, "], with start = ", FingerTable[i].start, ".");
        console.log("     FingerTable[", i, "] =", FingerTable[i].successor, "     <<<<<\n");
    }
}

/**
 * Directly implements the check_predecessor() method from the IEEE version of the paper.
 * 
 * @returns : true if predecessor was still reasonable; false otherwise.
 * @version 20191021
 */
async function check_predecessor() {
    if ((predecessor.id !== null) && (predecessor.id !== _self.id)) {
        const predecessor_client = caller(`localhost:${predecessor.port}`, PROTO_PATH, "Node");
        try {
            // just ask anything
            const x = await predecessor_client.getPredecessor(_self.id);
        } catch (err) {
            // predecessor = nil;
            predecessor = { id: null, ip: null, port: null };
            return false;
        }
    }
    return true;
}

/**
 * Checks whether the successor is still responding.
 * 
 * This is an original function, not described in either version of the paper - added 20191103.
 * 
 * @returns : true if successor was still reasonable; false otherwise.
 * @version 20191103
 */
async function check_successor() {
    // enable debugging output
    const DEBUGGING_LOCAL = false;
    if ((FingerTable[0].successor.id !== null) && (FingerTable[0].successor.id !== _self.id)) {
        try {
            // just ask anything
            await getSuccessor(FingerTable[0].successor.id, _self, FingerTable[0].successor);
        } catch (err) {
            if (DEBUGGING_LOCAL) {
                console.log("Error in check_successor({", _self.id, "})\n", err);
            }
            return false;
        }
    }
    return true;
}

/**
 * Placeholder for data migration within the join() call.
 * 
 * @version 20191103
 */
async function migrate_keys() {}

/* modified 20191021 */
async function main() {
    /**
     * Starts an RPC server that receives requests for the Greeter service at the
     * sample server port
     *
     * Takes the following optional flags
     * --id         - This node's id
     * --ip         - This node's IP Address'
     * --port       - This node's Port
     *
     * --targetId   - The ID of a node in the cluster
     * --targetIp   - The IP of a node in the cluster
     * --targetPort - The Port of a node in the cluster
     *
     */
    const args = minimist(process.argv.slice(2));
    _self.id = args.id ? args.id : 0;
    _self.ip = args.ip ? args.ip : `0.0.0.0`;
    _self.port = args.port ? args.port : 1337;

    if (
        args.targetIp !== null &&
        args.targetPort !== null &&
        args.targetId !== null
    ) {
        await join({ id: args.targetId, ip: args.targetIp, port: args.targetPort });
    } else {
        await join(null);
    }

    // Periodically run stabilize and fix_fingers
    // TODO this application of async/await may not be appropriate
    setInterval(async () => { await stabilize() }, 3000);
    setInterval(async () => { await fix_fingers() }, 3000);
    setInterval(async () => { await check_predecessor() }, 1000);

    const server = new grpc.Server();
    server.addService(chord.Node.service, {
        summary,
        fetch,
        insert,
        find_successor_remotehelper,
        getSuccessor_remotehelper,
        getSuccessorTable_remotehelper,
        getPredecessor,
        setPredecessor,
        closest_preceding_finger_remotehelper,
        update_finger_table,
        notify
    });
    server.bind(
        `${_self.ip}:${_self.port}`,
        grpc.ServerCredentials.createInsecure()
    );
    console.log(`Serving on ${_self.ip}:${_self.port}`);
    server.start();
}

// Creates a worker thread to execute crypto and returns a result.
// To use `const result = await sha1("stuff2");`
function sha1(source) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, "./cryptoThread.js"), { workerData: source });
        worker.on("message", resolve);
        worker.on("error", reject);
    });
};

// Example of using the thread
// async function test(){
//     let result = await sha1("stuff");
//     console.log("Result is: ", result);
//     result = await sha1("stuff2");
//     console.log("Result is: ", result);
// };
// test();


main();
