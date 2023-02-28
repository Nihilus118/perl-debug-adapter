use strict;
use warnings;

our $dbname = 'testdb';
our $dbpass = 'verySecurePassword';

sub test {
    print $_[0] . "\n";
    print "1\n";
    print "2\n";
    print "3\n";
    return
}

test ("Hello");

return 1;
