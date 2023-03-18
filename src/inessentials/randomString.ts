const randomStringGen = function(){
    const x = function*() {
        const alphabet = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456789~!@#$%^&*-_=+"]
        const alphabetSize = alphabet.length
        let len = 0
        for (;;)
            len = yield [...new Array(len).keys()]
                .map(i => alphabet[Math.floor(Math.random() * alphabetSize)])
                .join("")
    }()
    x.next()
    return x
}()

export function randomString(len: number) {
    return randomStringGen.next(len).value
}