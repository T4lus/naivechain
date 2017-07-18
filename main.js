

/*
HTTP API
Get blockchain:
curl http://localhost:3001/blocks
Create block:
curl -H "Content-type:application/json" --data "{\"data":\"Some data to the first block\"}" http://localhost:3001/mineBlock
Add peer:
curl -H "Content-type:application/json" --data '{"peer":"ws://localhost:6001"}' http://localhost:3001/addPeer
Query connected peers:
curl http://localhost:3001/peers
On Windows:
curl -H "Content-type:application/json" --data "{\"data\":\"Some data to the first block\"}" http://localhost:3001/mineBlock
New Wallet:
curl http://localhost:3001/newWallet
Pay:
curl -H "Content-type:application/json" --data "{\"fromPK\":\"047f89b9ecfc133b4f3de2cfe2eae9093fb1342d4896f944e070416448437d20536bbe504766d6be278d7c8fc6cee43fef8eed7fec5a7653b3deec92afc984d134\", \"fromIndex\":\"0\", \"toPK\":\"0459facfb2277d2e9c8b3a5fcef44d1f0b85e33855009d2552fd38ce8ada50832b18fab2c84eaa354ac5b3421179afa2868e1f70de1a527d5d772aba44998f6827\", \"amount\":\"125\", \"change\":\"875\", \"sk\":\"074439136697927594ac86dd991dcd1de14dc3575be430f80dffc00f4f454a03\", \"ts\":\"100\" }" http://localhost:3001/pay
wallet 1
{"sk":"074439136697927594ac86dd991dcd1de14dc3575be430f80dffc00f4f454a03",
"pk":"047f89b9ecfc133b4f3de2cfe2eae9093fb1342d4896f944e070416448437d20536bbe504766d6be278d7c8fc6cee43fef8eed7fec5a7653b3deec92afc984d134"}
wallet 2
{"sk":"0ccceabdc0a282a507c4e85ce2556b1d5ceeca031eec532393cdfbe6042a980b",
"pk":"0459facfb2277d2e9c8b3a5fcef44d1f0b85e33855009d2552fd38ce8ada50832b18fab2c84eaa354ac5b3421179afa2868e1f70de1a527d5d772aba44998f6827"}
*/




'use strict';

//naivechain
var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");

//elliptic
var elliptic = require('elliptic');
var BN = require('bn.js');
var hash = require('hash.js');
var Signature = require('elliptic/lib/elliptic/ec/signature');


var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

class Block {
    constructor(index, previousHash, timestamp, data, nonce, hash) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.nonce = nonce;
        this.hash = hash.toString();
    }
}

class Transaction {
    constructor(message, signature) {
        this.message = message;
        this.signature = signature;
    }
}



var sockets = [];
var MessageType = {
    QUERY_LATEST_BLOCK: 0,
    QUERY_ALL_BLOCKS: 1,
    QUERY_LATEST_TRANSACTION: 2,
    QUERY_ALL_TRANSACTIONS: 3,
    RESPONSE_BLOCKCHAIN: 4,
    RESPONSE_TRANSACTION: 5
};

var getGenesisBlock = () => {
    return new Block(0, "0", 1465154705, "// Regulators say 'shadow banking' has been tamed - Financial Times, Monday 3rd July 2017", 0, "4c25efcc5ee845170afd22b7287aa4d0ba5a9fd5db90a2e9f51c9043ec0ed695");
};

var difficulty = 3;

var blockchain = [getGenesisBlock()];
var transactions = [];


var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));

    app.post('/mineBlock', (req, res) => {
        var newBlock = generateNextBlock(req.body.data);
        addBlock(newBlock);
        broadcast(responseLatestBlockMsg());
        console.log('block added: ' + JSON.stringify(newBlock));
        res.send();
    });

    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });

    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });

    app.get('/newWallet', (req, res) => {        
        var curve = elliptic.curves['ed25519'];
        var ecdsa = new elliptic.ec(curve);
        var keys = ecdsa.genKeyPair();
        var pk = keys.getPublic('hex');
        var sk = keys.getPrivate('hex');
        res.send(JSON.stringify({ 'sk': sk, 'pk': pk }));
    });

    app.post('/pay', (req, res) => {

        //POST 
        //fromPK, fromIndex, toPK, toHash, amount, change

        var fromPK = req.body.fromPK;
        var fromIndex = req.body.fromIndex;
        var fromHash = CryptoJS.SHA256(fromPK).toString();  
        var toPK = req.body.toPK;
        var toHash = CryptoJS.SHA256(toPK).toString();  
        var amount = req.body.amount;
        var change = req.body.change;
        var sk = req.body.sk;
        var ts = new Date().getTime();
        var msg = {
            timestamp: { ts },
            inputs: [{ 'fromHash': fromHash, 'fromIndex': fromIndex, 'fromPK': fromPK }],
            outputs: [{ 'toHash': toHash, 'amount': amount }, { 'toHash': fromHash, 'amount': change }]
        };

        //hash the msg
        var msgHash = CryptoJS.SHA256(msg).toString();

        //sign the transaction msgHash
        var curve = elliptic.curves['ed25519'];
        var ecdsa = new elliptic.ec(curve);
        var signature = ecdsa.sign(JSON.stringify(msgHash), sk);

        //verify the signed msgHash
        console.log('verified signature: ' + ecdsa.verify(msgHash, signature, pk, 'hex'));

        //create a new transaction. only one input permitted
        var newTransaction = new Transaction(msg, signature);
        addTransaction(newTransaction);

        //broadcast transaction
        broadcast(responseLatestTransactionMsg(newTransaction));

        console.log('transaction added: ' + JSON.stringify(newTransaction));
        res.send();

    });

    app.listen(http_port, () => console.log('Listening http on port: ' + http_port));

};


var initP2PServer = () => {
    var server = new WebSocket.Server({port: p2p_port});
    server.on('connection', ws => initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);

};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryLatestBlockMsg());

    //get transactions?

};

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST_BLOCK:
                write(ws, responseLatestBlockMsg());
                break;
            case MessageType.QUERY_ALL_BLOCKS:
                write(ws, responseAllBlocksMsg());
                break;
            case MessageType.QUERY_LATEST_TRANSACTION:
                write(ws, responseLatestTransactionsMsg());
                break;
            case MessageType.QUERY_ALL_TRANSACTIONS:
                write(ws, responseAllTransactionsMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
            case MessageType.RESPONSE_TRANSACTION:
                handleTransactionResponse(message);
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};


var generateNextBlock = (blockData) => {
    console.log(new Date().getTime() + ' mining block..');
    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime() / 1000;
    //proof of work
    var nonce = 0;
    var nextHash = '';
    while (!isValidHashDifficulty(nextHash)) {
        nonce = nonce + 1;
        nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, nonce, blockData);        
    }
    console.log(new Date().getTime() + 'mined block! nonce/hash = ' + nonce + ' ' + nextHash);
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nonce, nextHash);
};




var isValidHashDifficulty = (hash) => {
    return (hash.indexOf(Array(difficulty + 1).join('0')) == 0);
}

var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.nonce, block.data);
};

var calculateHash = (index, previousHash, timestamp, nonce, data) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + nonce + data).toString();
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
    }
};


var addTransaction = (newTransaction) => {
    if (isValidNewTransaction(newTransaction)) {
        transactions.push(newTransaction);
    }
};


var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } else if (!isValidHashDifficulty(calculateHashForBlock(newBlock))) {
        console.log('invalid hash does not meet difficulty requirements: ' + calculateHashForBlock(newBlock));
        return false;        
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};


var isValidNewTransaction = (newTransaction) => {

    //to do 
    return true;
};


var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestBlockMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllBlocksMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than received blockchain. Do nothing');
    }
};


var handleTransactionResponse = (message) => {

    //needs work

    var receivedTransactions = JSON.parse(message.data).sort((b1, b2) => (b1.timestamp - b2.timestamp));

    //to do - verify incoming received here

    //merge and dedupe with local transactions
    var a = receivedTransactions;
    var b = transactions;
    var c = a.concat(b);
    var d = c.filter(function (item, pos) { return c.indexOf(item) == pos });
    var e = d.sort((b1, b2) => (b1.timestamp - b2.timestamp));

    //replace transaction array
    transactions = e;

    //broadcast all transactions
    broadcast(responseTransaction());
};



var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestBlockMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

var isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];


var isValidTransaction = (transaction) => {
    
    //sum outputs
    var sum = 0;
    transaction.message.outputs.forEach(function(output) {
        sum = sum + output.amount;
    });

    //check input exists and not spent
    //get block with index matching input 0 fromIndex 
    var fromBlock = blockchain[transaction.inputs[0].fromIndex];
    //find the transaction in the block
    var tx = getTransactionInBlock(fromBlock, transaction.inputs[0].fromHash);
    var fromTransaction = tx.transaction;
    var fromOutput = tx.output;

    //check that input equals sum of outputs
    if (fromOutput.amount != sum) {
        console.log('invalid transaction - inputs not equal to outputs');
        return false;
    }   

    //verify signature
    var msgHash = CryptoJS.SHA256(transaction.msg).toString();
    var isValid = ecdsa.verify(msgHash, transaction.signature, pk, 'hex');

    if (!isValid) {
        console.log('invalid transaction - invalid signature');
        return false;
    }
    
    return true;

}

var getTransactionInBlock = (fromBlock, fromHash) => {
    //for each transaction in the block
    fromBlock.data.forEach(function(transaction) {
        var outputs = transaction.outputs;
        outputs.forEach(function(output){
            if (output.toHash == fromHash) {
                return ({transaction, output});
            }
        });
    });
    return null;
}



//queries

var queryLatestBlockMsg = () => ({
    'type': MessageType.QUERY_LATEST_BLOCK
});

var queryAllBlocksMsg = () => ({
    'type': MessageType.QUERY_ALL_BLOCKS
});

var queryLatestTransactionMsg = () => ({
    'type': MessageType.QUERY_LATEST_TRANSACTION
});

var queryAllTransactions = () => ({
    'type': MessageType.QUERY_ALL_TRANSACTIONS
});

//responses

var responseAllBlocksMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify(blockchain)
});

var responseLatestBlockMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

var responseAllTransactionsMsg = () => ({
    'type': MessageType.RESPONSE_TRANSACTION,
    'data': JSON.stringify(transactions)
});

var responseLatestTransactionMsg = (transaction) => ({
    'type': MessageType.RESPONSE_TRANSACTION,
    'data': JSON.stringify(transaction)
});




var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

connectToPeers(initialPeers);

initHttpServer();
initP2PServer();

//calc genesis block hash
var calcGenesisHash = () => {
    var newb = calculateHashForBlock ( getGenesisBlock() );
    console.log('genesis hash = ' + newb);
}
calcGenesisHash();





